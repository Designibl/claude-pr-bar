# claude-pr-bar

Your GitHub pull requests in the Claude Code sidebar. A port of [PR Bar](https://github.com/Designibl/pr-bar)
(the macOS menu bar app) as a Claude Code mod, with Claude as the only agent.

## What it shows

- **Status line**: `PRs 4 · 👀 2` (open PRs you authored, PRs awaiting *your* review)
- **Band above the prompt**: `PRs: 4 open · 👀 2 to review · 1 ready to merge · 2 need fixes`, with Open list and Refresh buttons
- **Full list pane** (`/pr-bar` or the band's Open list button) with collapsible sections: *Awaiting your review* (requested of you, then per team), *Ready to merge*, *Ready for review*, *Awaiting fixes*, *In draft*
- Per PR: files, +/- lines, age of latest commit (amber > 7d, red > 14d), CI, merge status, fix reasons, Linear/GitHub issue and preview links
- **Review with Claude / Fix with Claude / Self-review** buttons submit a prompt into the current session
- **Copy** a Markdown, Slack or plain-text summary (all / needs my review / awaiting review)
- Poll interval (1–60 min) and whether team requests count toward 👀

## Commands

`/pr-bar` opens the pane. Also: `refresh`, `interval <1|5|15|30|60>`, `teams on|off`, `copy [md|slack|text] [all|review|mine]`.

## Requirements

[`gh`](https://cli.github.com) logged in (`gh auth login`; team groups need the `read:org` scope).

## Install

```bash
git clone https://github.com/Designibl/claude-pr-bar.git
claude --plugin-dir ./claude-pr-bar
```

Settings and the last poll are stored with the mod's `$.store`, so they persist across sessions.

## Licence

[MIT](LICENSE)
