export type Link = { label: string; url: string }

export type Pr = {
  number: number
  title: string
  url: string
  repo: string
  author: string
  isDraft: boolean
  additions: number
  deletions: number
  files: number
  lastChange: string | null
  mergeable: string | null
  mergeState: string | null
  reviewDecision: string | null
  ci: string | null
  isCiBlocking: boolean
  unresolvedThreads: number
  issues: Link[]
  previews: Link[]
  isReviewRequested: boolean
  reviewVia: string[]
  fixReasons: string[]
  bucket: 'draft' | 'fixes' | 'merge' | 'ready'
}

export type PrData = {
  fetchedAt: string | null
  login: string | null
  prs: Pr[]
  error: string | null
}

export type Settings = {
  intervalMinutes: number
  isCountingTeams: boolean
}

export type View = {
  collapsed: string[]
  format: 'md' | 'slack' | 'text'
}

declare module 'claude-code' {
  interface PluginState {
    'pr-bar': { data: PrData; settings: Settings; view: View; isBusy: boolean }
  }
}
