import { atom, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'

import type { Link, Pr, PrData, Settings, View } from '../types'

type Api = Parameters<Hook<'session.start'>>[0]
type Node = any

const PANE = 'pr-bar'
const YOU = 'You'
const INTERVALS = [1, 5, 15, 30, 60]
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']

const data = atom({ plugin: 'pr-bar', key: 'data' } as const, {
  fetchedAt: null,
  login: null,
  prs: [],
  error: null,
})
const settings = atom({ plugin: 'pr-bar', key: 'settings' } as const, {
  intervalMinutes: 5,
  isCountingTeams: false,
})
const view = atom({ plugin: 'pr-bar', key: 'view' } as const, {
  collapsed: [],
  format: 'md',
})
const readSettings = async ($: Api): Promise<Settings> => (await read($, settings)) as Settings
const isBusy = atom({ plugin: 'pr-bar', key: 'isBusy' } as const, false)

const SECTIONS = [
  ['review', 'Awaiting your review'],
  ['merge', 'Ready to merge'],
  ['ready', 'Ready for review'],
  ['fixes', 'Awaiting fixes'],
  ['draft', 'In draft'],
] as const

// ------------------------------------------------------------------ GitHub

const QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        id number title url isDraft body updatedAt
        additions deletions changedFiles
        mergeable mergeStateStatus reviewDecision
        author { login }
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
        comments(last: 30) { nodes { body } }
        reviewThreads(first: 100) { nodes { isResolved } }
      }
    }
  }
}`

let ghPath: string | null = null

async function gh($: Api, args: string[]): Promise<string> {
  const candidates = ghPath ? [ghPath] : GH_CANDIDATES
  let lastError = 'gh not found: install it with `brew install gh`'
  for (const bin of candidates) {
    let ran
    try {
      ran = await $.process.run([bin, ...args], {
        env: { GH_PROMPT_DISABLED: '1' },
        timeoutMs: 120_000,
      })
    } catch {
      continue
    }
    ghPath = bin
    if (ran.exitCode !== 0) {
      throw new Error((ran.stderr || ran.stdout).trim() || 'gh failed')
    }
    return ran.stdout
  }
  throw new Error(lastError)
}

async function search($: Api, q: string): Promise<Node[]> {
  const out = await gh($, ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `q=${q}`])
  return (JSON.parse(out).data.search.nodes as Node[]).filter(Boolean)
}

async function myTeams($: Api): Promise<string[]> {
  try {
    const pages = JSON.parse(await gh($, ['api', 'user/teams', '--paginate', '--slurp']))
    return pages
      .flat()
      .map((t: Node) => `${t.organization.login}/${t.slug}`)
      .sort()
  } catch {
    return [] // needs the read:org scope
  }
}

async function reviewRequests($: Api, login: string): Promise<[Node, string[]][]> {
  const found = new Map<string, [Node, string[]]>()
  const add = (nodes: Node[], via: string) => {
    for (const n of nodes) {
      const entry = found.get(n.id) ?? [n, []]
      if (!entry[1].includes(via)) entry[1].push(via)
      found.set(n.id, entry)
    }
  }
  const base = `is:pr is:open archived:false -author:${login} sort:updated-desc`
  add(await search($, `${base} user-review-requested:${login}`), YOU)
  for (const team of await myTeams($)) {
    try {
      add(await search($, `${base} team-review-requested:${team}`), team)
    } catch {
      // a team the token can't search shouldn't fail the whole poll
    }
  }
  return [...found.values()]
}

const rollupState = (n: Node): string | null =>
  n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null

/** Sets `_blocking` on failing PRs: true when a *required* check fails (or none are required). */
async function requiredFailures($: Api, nodes: Node[]): Promise<void> {
  const failing = nodes.filter(n => ['FAILURE', 'ERROR'].includes(rollupState(n) ?? ''))
  if (failing.length === 0) return
  const parts = failing.map(
    (n, i) =>
      `p${i}: node(id: "${n.id}") { ... on PullRequest { commits(last: 1) { nodes { commit { statusCheckRollup {` +
      ` contexts(first: 100) { nodes { __typename` +
      ` ... on CheckRun { conclusion isRequired(pullRequestId: "${n.id}") }` +
      ` ... on StatusContext { state isRequired(pullRequestId: "${n.id}") } } } } } } } } }`,
  )
  let result: Node
  try {
    result = JSON.parse(await gh($, ['api', 'graphql', '-f', `query=query { ${parts.join(' ')} }`])).data
  } catch {
    return // fall back to treating any failure as blocking
  }
  const bad = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED']
  failing.forEach((n, i) => {
    const ctxs: Node[] | undefined =
      result?.[`p${i}`]?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes
    if (!ctxs) return
    const required = ctxs.filter(x => x?.isRequired)
    n._blocking = required.length ? required.some(x => bad.includes(x.conclusion ?? x.state)) : true
  })
}

// ----------------------------------------------------------- normalisation

const LINEAR_RE = /https:\/\/linear\.app\/[\w-]+\/issue\/[A-Z][A-Z0-9]*-\d+[^\s)>\]"']*/g
const GH_ISSUE_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/g
const PREVIEW_RE = /https:\/\/[\w.-]+\.(?:vercel\.app|netlify\.app|pages\.dev|onrender\.com|surge\.sh)[^\s)>\]"']*/g

const trim = (u: string) => u.replace(/[.,;:!?)\]}>'"]+$/, '')
const unique = (xs: string[]) => [...new Set(xs.map(trim))]

function extractLinks(blob: string): { issues: Link[]; previews: Link[] } {
  const issues: Link[] = []
  for (const u of unique(blob.match(LINEAR_RE) ?? [])) {
    const m = /\/issue\/([A-Z][A-Z0-9]*-\d+)/.exec(u)
    if (m) issues.push({ label: m[1]!, url: u.split(m[1]!)[0] + m[1] })
  }
  for (const u of unique(blob.match(GH_ISSUE_RE) ?? [])) {
    const p = u.split('/')
    issues.push({ label: `${p[3]}/${p[4]}#${p[6]}`, url: u })
  }
  const previews = unique(blob.match(PREVIEW_RE) ?? []).map(u => ({
    label: u.replace(/^https:\/\//, '').split('/')[0]!,
    url: u,
  }))
  return { issues, previews }
}

function fixReasons(pr: Pick<Pr, 'reviewDecision' | 'unresolvedThreads' | 'mergeable' | 'isCiBlocking'>) {
  const reasons: string[] = []
  if (pr.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes requested')
  if (pr.unresolvedThreads) {
    reasons.push(`${pr.unresolvedThreads} unresolved comment${pr.unresolvedThreads === 1 ? '' : 's'}`)
  }
  if (pr.mergeable === 'CONFLICTING') reasons.push('merge conflicts')
  if (pr.isCiBlocking) reasons.push('blocking CI failing')
  return reasons
}

function normalise(n: Node, isReviewRequested = false, via: string[] = []): Pr {
  const commit = n.commits?.nodes?.[0]?.commit ?? {}
  const ci: string | null = commit.statusCheckRollup?.state ?? null
  const comments = (n.comments?.nodes ?? []).map((c: Node) => c.body ?? '')
  const { issues, previews } = extractLinks([n.body ?? '', ...comments].join('\n'))
  const pr = {
    number: n.number,
    title: n.title,
    url: n.url,
    repo: n.repository.nameWithOwner,
    author: n.author?.login ?? 'ghost',
    isDraft: n.isDraft,
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
    files: n.changedFiles ?? 0,
    lastChange: commit.committedDate ?? n.updatedAt ?? null,
    mergeable: n.mergeable ?? null,
    mergeState: n.mergeStateStatus ?? null,
    reviewDecision: n.reviewDecision ?? null,
    ci,
    isCiBlocking: n._blocking ?? ['FAILURE', 'ERROR'].includes(ci ?? ''),
    unresolvedThreads: (n.reviewThreads?.nodes ?? []).filter((t: Node) => t && !t.isResolved).length,
    issues,
    previews,
    isReviewRequested,
    reviewVia: via,
  }
  const reasons = fixReasons(pr)
  const bucket: Pr['bucket'] = pr.isDraft
    ? 'draft'
    : reasons.length
      ? 'fixes'
      : pr.reviewDecision === 'APPROVED'
        ? 'merge'
        : 'ready'
  return { ...pr, fixReasons: reasons, bucket }
}

// ------------------------------------------------------------- derivations

const sectionOf = (pr: Pr) => (pr.isReviewRequested ? 'review' : pr.bucket)

function grouped(prs: Pr[]): Record<string, Pr[]> {
  const out: Record<string, Pr[]> = { review: [], merge: [], ready: [], fixes: [], draft: [] }
  for (const pr of prs) out[sectionOf(pr)]!.push(pr)
  return out
}

function reviewGroups(items: Pr[]): [string, Pr[]][] {
  const by = new Map<string, Pr[]>()
  for (const pr of items) {
    for (const via of pr.reviewVia.length ? pr.reviewVia : [YOU]) {
      by.set(via, [...(by.get(via) ?? []), pr])
    }
  }
  return [...by.entries()].sort(([a], [b]) =>
    a === YOU ? -1 : b === YOU ? 1 : a.toLowerCase().localeCompare(b.toLowerCase()),
  )
}

const reviewCount = (items: Pr[], isCountingTeams: boolean) =>
  isCountingTeams ? items.length : items.filter(pr => !pr.reviewVia.length || pr.reviewVia.includes(YOU)).length

function fmtAge(iso: string | null, now: number): { text: string; color?: string } {
  if (!iso) return { text: 'unknown' }
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  const text =
    secs >= 86400 ? `${Math.floor(secs / 86400)}d` : secs >= 3600 ? `${Math.floor(secs / 3600)}h` : secs >= 60 ? `${Math.floor(secs / 60)}m` : '<1m'
  return { text, color: secs > 14 * 86400 ? 'red' : secs > 7 * 86400 ? 'yellow' : undefined }
}

const CI_TEXT: Record<string, string> = {
  SUCCESS: 'CI passing',
  FAILURE: 'CI failing',
  ERROR: 'CI failing',
  PENDING: 'CI running',
  EXPECTED: 'CI running',
}
const ciText = (ci: string | null) => (ci && CI_TEXT[ci]) || 'no CI'
const ciColor = (ci: string | null) =>
  ci === 'SUCCESS' ? 'green' : ci === 'FAILURE' || ci === 'ERROR' ? 'red' : ci ? 'yellow' : undefined

function mergeText(pr: Pr): string {
  if (pr.mergeable === 'CONFLICTING') return 'conflicts with base'
  const t: Record<string, string> = {
    CLEAN: 'ready to merge',
    BLOCKED: 'blocked (reviews/checks required)',
    BEHIND: 'behind base branch',
    UNSTABLE: 'mergeable, checks unstable',
    HAS_HOOKS: 'ready to merge',
    DRAFT: 'draft',
  }
  return (pr.mergeState && t[pr.mergeState]) || 'merge status pending'
}

const SCOPES = { all: null, review: ['review'], mine: ['ready'] } as const
type Scope = keyof typeof SCOPES

function formatSummary(prs: Pr[], fmt: View['format'], scope: Scope): string {
  const wanted = SCOPES[scope]
  const by = grouped(prs)
  const lines: string[] = []
  const heading = (text: string, isSub = false) =>
    lines.push(fmt === 'md' ? (isSub ? `*${text}*` : `**${text}**`) : fmt === 'slack' ? (isSub ? `_${text}_` : `*${text}*`) : text)
  const entry = (pr: Pr) => {
    const meta = `${pr.repo}, +${pr.additions}/-${pr.deletions}, ${ciText(pr.ci)}`
    const label = `#${pr.number} ${pr.title}`
    // Slack doesn't parse <url|label> on paste, so a bare URL after the label autolinks safely.
    return fmt === 'md' ? `- [${label}](${pr.url}) (${meta})` : `- ${label} (${meta}) ${pr.url}`
  }
  for (const [key, title] of SECTIONS) {
    if (wanted && !(wanted as readonly string[]).includes(key)) continue
    const items = by[key]!
    if (!items.length) continue
    heading(`${title} (${items.length})`)
    if (key === 'review') {
      for (const [via, sub] of reviewGroups(items)) {
        heading(`${via === YOU ? 'Requested of you' : `Team ${via}`} (${sub.length})`, true)
        lines.push(...sub.map(entry))
      }
    } else {
      lines.push(...items.map(entry))
    }
    lines.push('')
  }
  return lines.join('\n').trim() || 'No open pull requests.'
}

// ----------------------------------------------------------------- polling

async function refresh($: Api): Promise<void> {
  if (await read($, isBusy)) return
  await update($, isBusy, () => true)
  const now = new Date().toISOString()
  try {
    const login = (await gh($, ['api', 'user', '--jq', '.login'])).trim()
    const mine = await search($, `is:pr is:open archived:false author:${login} sort:updated-desc`)
    const asked = await reviewRequests($, login)
    await requiredFailures($, mine)
    const prs = [...mine.map(n => normalise(n)), ...asked.map(([n, via]) => normalise(n, true, via))]
    const next: PrData = { fetchedAt: now, login, prs, error: null }
    await update($, data, () => next)
    await $.store.set('data', next)
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300)
    await update($, data, old => ({ ...old, error: message }))
  } finally {
    await update($, isBusy, () => false)
    await setStatus($)
  }
}

async function setStatus($: Api): Promise<void> {
  const { prs, error } = await read($, data)
  const { isCountingTeams } = await readSettings($)
  if (error && prs.length === 0) return $.ui.status('PR Bar: ! (see /pr-bar)')
  const mine = prs.filter(p => !p.isReviewRequested).length
  const eyes = reviewCount(prs.filter(p => p.isReviewRequested), isCountingTeams)
  $.ui.status(`PRs ${mine}${eyes ? ` · 👀 ${eyes}` : ''}${error ? ' !' : ''}`)
}

// ------------------------------------------------------------------ prompts

const reviewPrompt = (pr: Pr) =>
  `Review pull request ${pr.url} (${pr.repo}#${pr.number}: ${pr.title}). ` +
  `Use \`gh pr view\` and \`gh pr diff\` to read it, check the diff for correctness bugs, risky changes and missing tests, ` +
  `and give me a concise review with specific file/line feedback. Do not post anything to GitHub unless I ask.`

const fixPrompt = (pr: Pr) =>
  `My pull request ${pr.url} (${pr.repo}#${pr.number}: ${pr.title}) needs work: ${pr.fixReasons.join(', ')}. ` +
  `Use \`gh pr view --comments\`, \`gh pr checks\` and the review threads to find out exactly what is outstanding, ` +
  `then propose the fixes. Check out the branch only if you are in a clone of ${pr.repo}.`

// -------------------------------------------------------------------- hooks

let timer: { cancel: () => void } | undefined

function schedule($: Api, minutes: number): void {
  timer?.cancel()
  timer = $.clock.every(minutes * 60_000, () => void refresh($))
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get('settings')) as Settings | undefined
    const cached = (await $.store.get('data')) as PrData | undefined
    const view0 = (await $.store.get('view')) as View | undefined
    if (stored) await update($, settings, () => ({ ...stored }))
    if (cached) await update($, data, () => cached)
    if (view0) await update($, view, () => view0)
    await $.command.register({
      name: 'pr-bar',
      description: 'GitHub PRs pane: /pr-bar [refresh | interval <min> | teams on|off | copy [md|slack|text] [all|review|mine]]',
    })
    schedule($, (await readSettings($)).intervalMinutes)
    void refresh($)
    void $.ui.open({ id: PANE, title: 'PRs' })
    return next(e)
  })

  on('command.run', { command: 'pr-bar' }, async ($, e) => {
    const [cmd, a, b] = e.args.trim().split(/\s+/)
    if (cmd === 'refresh') {
      await refresh($)
      return { text: 'PR Bar refreshed.' }
    }
    if (cmd === 'interval') {
      const minutes = Number(a)
      if (!INTERVALS.includes(minutes)) return { text: `Interval must be one of ${INTERVALS.join(', ')} minutes.` }
      const next = { ...(await readSettings($)), intervalMinutes: minutes }
      await update($, settings, () => next)
      await $.store.set('settings', next)
      schedule($, minutes)
      return { text: `PR Bar polls every ${minutes} minute${minutes === 1 ? '' : 's'}.` }
    }
    if (cmd === 'teams') {
      const next = { ...(await readSettings($)), isCountingTeams: a === 'on' }
      await update($, settings, () => next)
      await $.store.set('settings', next)
      await setStatus($)
      return { text: `Team review requests ${next.isCountingTeams ? 'now count' : 'no longer count'} toward 👀.` }
    }
    if (cmd === 'copy') {
      const fmt = (['md', 'slack', 'text'] as const).find(f => f === a) ?? (await read($, view)).format
      const scope = (['all', 'review', 'mine'] as const).find(s => s === b) ?? 'all'
      const text = formatSummary((await read($, data)).prs, fmt, scope)
      const copied = await $.ui.copy({ text, surface: e.origin && 'surface' in e.origin ? (e.origin as any).surface : undefined })
      return { text: copied.isCopied ? `Copied ${scope} summary (${fmt}).` : text }
    }
    await $.ui.open({ id: PANE, title: 'PRs', focus: true })
    return { text: 'PR Bar opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const d = await read($, data)
    const s = await readSettings($)
    const v = await read($, view)
    const busy = await read($, isBusy)
    const now = await $.clock.now()
    const by = grouped(d.prs)
    let budget = Math.max(6, (e.viewport?.rows ?? 30) - 6)

    const prRow = (pr: Pr, key: string) => {
      const age = fmtAge(pr.lastChange, now)
      const draftOrFix = !pr.isReviewRequested && pr.bucket === 'fixes'
      budget -= 2
      return (
        <Box key={key} flexDirection="column" marginBottom={0}>
          <Box>
            <Link href={pr.url}>{`#${pr.number} ${pr.title}`}</Link>
          </Box>
          <Box>
            <Text dimColor>{pr.repo} · {pr.files}f +{pr.additions}/-{pr.deletions} · </Text>
            <Text color={age.color} dimColor={!age.color}>{age.text}</Text>
            <Text dimColor> · </Text>
            <Text color={ciColor(pr.ci)}>{ciText(pr.ci)}</Text>
            <Text dimColor> · {pr.isReviewRequested ? `by ${pr.author}` : mergeText(pr)}</Text>
          </Box>
          {draftOrFix && <Text color="red">  {pr.fixReasons.join(', ')}</Text>}
          <Box>
            {pr.issues.map(l => (
              <Link key={l.url} href={l.url}>{`${l.label} `}</Link>
            ))}
            {pr.previews.map(l => (
              <Link key={l.url} href={l.url}>{`${l.label} `}</Link>
            ))}
            {pr.isReviewRequested || pr.bucket === 'ready' || pr.bucket === 'fixes' ? (
              <Button
                key={`act-${key}`}
                label={pr.isReviewRequested ? 'Review with Claude' : pr.bucket === 'fixes' ? 'Fix with Claude' : 'Self-review'}
                onPress={() => $.prompt.submit({ text: pr.isReviewRequested || pr.bucket === 'ready' ? reviewPrompt(pr) : fixPrompt(pr) })}
              />
            ) : null}
          </Box>
        </Box>
      )
    }

    const sectionEl = (key: string, title: string, items: Pr[]) => {
      const isOpen = !v.collapsed.includes(key)
      budget -= 1
      return (
        <Box key={`s-${key}`} flexDirection="column" marginTop={1}>
          <Button
            key={`toggle-${key}`}
            label={`${isOpen ? '▾' : '▸'} ${title} (${items.length})`}
            onPress={async () => {
              const next = { ...v, collapsed: isOpen ? [...v.collapsed, key] : v.collapsed.filter(k => k !== key) }
              await update($, view, () => next)
              await $.store.set('view', next)
            }}
          />
          {isOpen &&
            (key === 'review'
              ? reviewGroups(items).map(([via, sub]) => (
                  <Box key={`g-${via}`} flexDirection="column">
                    <Text dimColor>{via === YOU ? 'Requested of you' : `Team ${via}`} ({sub.length})</Text>
                    {sub.map(pr => (budget > 0 ? prRow(pr, `${key}-${via}-${pr.url}`) : null))}
                  </Box>
                ))
              : items.map(pr => (budget > 0 ? prRow(pr, `${key}-${pr.url}`) : null)))}
        </Box>
      )
    }

    const copy = (scope: Scope, label: string) => (
      <Button
        key={`copy-${scope}`}
        label={label}
        onPress={press =>
          $.ui.copy({ text: formatSummary(d.prs, v.format, scope), surface: press.surface })
        }
      />
    )
    const nextFormat = { md: 'slack', slack: 'text', text: 'md' } as const
    const eyes = reviewCount(by.review!, s.isCountingTeams)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>{d.prs.filter(p => !p.isReviewRequested).length} open</Text>
          {eyes > 0 && <Text> · 👀 {eyes}</Text>}
          <Text dimColor> · {busy ? 'refreshing…' : d.fetchedAt ? `updated ${fmtAge(d.fetchedAt, now).text} ago` : 'no data yet'} </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
        {d.error && <Text color="red">! {d.error}</Text>}
        {d.prs.length === 0 && !d.error && <Text dimColor>No open pull requests.</Text>}
        {SECTIONS.map(([key, title]) => (by[key]!.length ? sectionEl(key, title, by[key]!) : null))}
        {budget <= 0 && <Text dimColor>… more hidden; collapse sections to see the rest</Text>}
        <Box marginTop={1}>
          <Text dimColor>Copy </Text>
          {copy('all', 'all')}
          {copy('review', 'to review')}
          {copy('mine', 'awaiting review')}
          <Button
            key="format"
            label={`as ${v.format}`}
            onPress={async () => {
              const next = { ...v, format: nextFormat[v.format] }
              await update($, view, () => next)
              await $.store.set('view', next)
            }}
          />
        </Box>
        <Box>
          <Text dimColor>Poll </Text>
          {INTERVALS.map(m => (
            <Button
              key={`i-${m}`}
              label={m === s.intervalMinutes ? `[${m}m]` : `${m}m`}
              onPress={async () => {
                const next = { ...s, intervalMinutes: m }
                await update($, settings, () => next)
                await $.store.set('settings', next)
                schedule($, m)
              }}
            />
          ))}
          <Button
            key="teams"
            label={s.isCountingTeams ? '👀 incl. teams' : '👀 direct only'}
            onPress={async () => {
              const next = { ...s, isCountingTeams: !s.isCountingTeams }
              await update($, settings, () => next)
              await $.store.set('settings', next)
              await setStatus($)
            }}
          />
        </Box>
      </Box>
    )
  })
}
