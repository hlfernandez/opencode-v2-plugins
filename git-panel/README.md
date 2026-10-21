# opencode-git-panel

A Git section in the [OpenCode](https://opencode.ai) V2 CLI sidebar — the latest
commit plus the modified and new files waiting to be committed, updated while you
work.

```text
▼ Git main (3)
8cd8f3f docs(pdca-slides): освежить деку…
2h ago
  Modified (2)
    M opencode/plugins/git-panel/tui.tsx
    M README.md
  New (1)
    ? opencode/plugins/git-panel/.vscode/
```

- **Latest commit**: abbreviated hash, subject, and a compact relative time.
- **Modified**: tracked files with any staged or unstaged change, prefixed with a
  status glyph (`M`, `A`, `D`, `R`, `C`, `T`, `U`).
- **New**: untracked files, prefixed with `?`.
- Empty lists are omitted; a clean tree shows `✓ Working tree clean`.
- Click the header to collapse or expand the section; the state persists across
  restarts.
- Lists default to five rows each, with `+N more` for the rest.
- All git reads are async, so the terminal never waits for git.

## Requirements

- OpenCode V2 CLI (`opencode` 2.x).
- `git` on `PATH`.
- The session sidebar must be visible (`session.sidebar` is `auto` by default and
  the host hides the sidebar when the terminal is too narrow).

## Install

This is a **CLI-only** plugin: it renders in the terminal and has no server
entrypoint. Install the published package by adding it to `cli.json` (not to
`opencode.json(c)`):

```jsonc title="~/.config/opencode/cli.json"
{
  "plugins": [
    { "package": "opencode-git-panel", "options": { "interval": 2500, "maxFiles": 5 } }
  ]
}
```

A string entry works too and uses the defaults:

```jsonc
{ "plugins": ["opencode-git-panel"] }
```

Options are only available through the `cli.json` entry. For a local checkout you
do not need that entry: OpenCode discovers packages placed in
`<config>/plugins/<name>/` automatically. See [Local development](#local-development)
for when to add it explicitly.

CLI-only plugins stay active when the CLI is connected to a remote server, because
they run locally in the terminal.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `interval` | number (ms) | `2500` | Refresh period. Values below `500` fall back to `2500`. |
| `maxFiles` | integer | `5` | Rows per list, capped at 50. `0` shows every file. |
| `enabled` | boolean | `true` | Set to `false` to keep the package configured but unloaded. |

Refresh also runs (debounced) on `filesystem.changed`, `vcs.branch.updated`,
`session.idle`, `worktree.resolved` and `worktree.updated` events. Event names
missing on a host version are ignored; the timer still covers them.

## Per-project directory

By default the panel follows the active session's directory. To track another
local repository in one project, add a config file under that project's
`.opencode/` directory:

```jsonc title="<project>/.opencode/git-panel.json"
{
  "directory": "../infra"
}
```

- `directory` may be absolute, start with `~/`, or be relative to the project
  root (the directory that contains `.opencode/`). Absolute paths are recommended.
- The nearest file walking up from the session directory wins. When the session
  has no config of its own, a worktree falls back to the canonical checkout's
  file.
- The header shows `↗ <name>` while an override is active.
- If the configured directory is missing or is not a Git repository, the panel
  shows that message in orange instead of git data. The server directory is
  never used as a silent fallback.
- Invalid JSON or a non-string `directory` is ignored with a warning in the log,
  keeping the default behavior.

There is no project-local `cli.json`, so this file is the only per-project
setting the plugin reads. Plugin options in `opencode.json(c)` reach server
plugins only, not this CLI-only package.

## What it shows

| Part | Source | Color |
| --- | --- | --- |
| header | branch from `# branch.head` | accent |
| `↗ <name>` | configured project directory | muted |
| `(N)` | modified + untracked count | muted |
| hash | `git log -1 --format=%h` | warning |
| subject | `git log -1 --format=%s` | base text |
| relative time | `git log -1 --format=%ct` | muted |
| `M` | tracked modification | warning |
| `A` | staged addition | success |
| `D` / `U` | deletion / conflict | error |
| `R` / `C` | rename / copy | info |
| `T` | type change | warning |
| `?` | untracked | muted |
| `+N more` | files beyond `maxFiles` | muted |
| `✓` | working tree clean | success |

A detached HEAD renders `detached` in the header. An empty repository shows
`No commits yet`.

## How it reads git

- `git -c status.relativePaths=false status --porcelain=v2 --branch -z --untracked-files=normal`
- `git log -1 --format=%h%x1f%s%x1f%ct`

All calls use `GIT_OPTIONAL_LOCKS=0`, a 5 s timeout and an 8 MB output cap, so
refreshes never take index locks or hang the UI. Paths are always relative to the
repository root, even when the session lives in a subdirectory. The directory is
the active session's location, unless a [project config](#per-project-directory)
points somewhere else, falling back to the current location and its default.

## Notes and limitations

- Read-only: the panel does not stage, commit or open diffs.
- Untracked directories appear as one entry because of
  `--untracked-files=normal`; the list does not expand them into individual files.
- With `session.sidebar: "hide"`, or in a terminal too narrow for the sidebar,
  nothing is rendered.
- Worktrees: the panel follows the session's location, so open the session in the
  worktree directory to see that worktree's changes.
- The project config is read by the local CLI process, so with a remote server its
  paths must exist on the machine running the CLI.
- A project config can point the panel at any local path, including outside the
  workspace; the reads stay read-only.

## Local development

Plugins are discovered from `<config>/plugins/<name>/`, so the same package layout
works from disk:

```text
~/.config/opencode/plugins/git-panel/
├── package.json   # exports: { "./tui": "./tui.tsx" }
├── data.ts
└── tui.tsx
```

Dropping or symlinking the directory there is enough — no `cli.json` entry is
required. Add one only when you want to pass options or control plugin ordering:

```jsonc title="~/.config/opencode/cli.json"
{
  "plugins": [
    { "package": "./plugins/git-panel", "options": { "interval": 2500, "maxFiles": 5 } }
  ]
}
```

Run the data-layer smoke test (Node 22+ or Bun):

```sh
npm test
# or
bun test/smoke.mjs
```

`opencode plugin list` shows local entries with source `local` and package entries
with their resolved version.

## License

MIT
