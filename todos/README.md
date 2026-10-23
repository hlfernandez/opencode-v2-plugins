# opencode-todos-panel

A TODO list in the [OpenCode](https://opencode.ai) V2 CLI sidebar, backed by a
plain text file and managed from the prompt with stack-style commands.

```text
▼ TODOs (3)
  ▸ 1. finish the plugin docs
    2. run the tests
    3. try it in the TUI
```

The first line is the top of the list. It is highlighted because it is the line
that `/todos pop` removes.

## Features

- Reads `.opencode/todos.txt`, one TODO per non-empty line.
- Shows the list in the right sidebar, with a count and a collapsible header.
- `/todos add <text>` appends to the bottom.
- `/todos push <text>` inserts at the top.
- `/todos pop` removes the first/top TODO and shows which one was removed.
- Command-palette actions prompt for text, so you do not have to type the full
  slash command.
- Updates immediately after each command and follows external edits within about
  one second.
- Always visible: an empty or missing file shows `TODOs (0)` and `No todos yet`.

## Requirements

- OpenCode V2 CLI (`opencode` 2.x).
- The session sidebar must be visible (`session.sidebar` is `auto` by default and
  the host hides the sidebar when the terminal is too narrow).

## Install

This is a **CLI-only** plugin: it renders in the terminal and has no server
entrypoint. Add it to `cli.json` (not to `opencode.json(c)`):

```jsonc title="~/.config/opencode/cli.json"
{
  "plugins": [
    { "package": "opencode-todos-panel", "options": { "interval": 1000, "maxItems": 10 } }
  ]
}
```

A string entry works too and uses the defaults:

```jsonc
{ "plugins": ["opencode-todos-panel"] }
```

For a local checkout, OpenCode discovers packages placed in
`<config>/plugins/<name>/` automatically:

```sh
ln -s /path/to/opencode-v2-plugins/todos ~/.config/opencode/plugins/todos
```

No `cli.json` entry is needed when using the symlink, unless you want to pass
options or control plugin ordering.

## Commands

Type these in the prompt:

| Command | Effect |
| --- | --- |
| `/todos add <text>` | Append `<text>` after the last TODO. |
| `/todos push <text>` | Insert `<text>` at the top. |
| `/todos pop` | Remove and report the first/top TODO. |

`/todos add` or `/todos push` without text shows the usage hint. Unknown
subcommands are reported without changing the file.

The command palette (`Ctrl+P`) also contains:

- **Add TODO at the end** — prompts for text, then appends it.
- **Push TODO to the top** — prompts for text, then inserts it at the top.
- **Pop the first TODO** — removes the first line.

The commands are registered with these IDs, so you can bind them in `cli.json`:

| ID | Action |
| --- | --- |
| `hlfernandez.todos` | `/todos` slash command |
| `hlfernandez.todos.add` | Add at the end (prompts for text) |
| `hlfernandez.todos.push` | Push to the top (prompts for text) |
| `hlfernandez.todos.pop` | Pop the first TODO |

```jsonc title="~/.config/opencode/cli.json"
{
  "keybinds": {
    "hlfernandez.todos.pop": "alt+p"
  }
}
```

There are no default keybindings.

## File location and format

The active session's **project root** is used:

```text
<project-root>/.opencode/todos.txt
```

- The project root is the canonical project directory reported by OpenCode,
  falling back to the session directory when no project is available.
- Worktrees therefore share the main checkout's list. Open the session in a
  separate project (or point a different project root at it) for a separate list.
- The file is created automatically by `add`/`push`, including the `.opencode/`
  directory.
- Empty lines are ignored. Lines are trimmed when read and when written.
- Writes replace the file with the current list and a trailing newline (the file
  is empty when the list is empty). The write is atomic (temporary file +
  rename), so the panel never reads a half-written file.
- `pop` on an empty or missing file does not create the file.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `interval` | number (ms) | `1000` | Refresh period. Values below `250` fall back to `1000`. |
| `maxItems` | integer | `10` | Maximum rows shown; `+N more` follows the list. `0` shows every TODO. |
| `enabled` | boolean | `true` | Set to `false` to keep the package configured but unloaded. |

Refresh also runs (debounced) on `filesystem.changed`, `worktree.resolved` and
`worktree.updated` events. Event names missing on a host version are ignored;
the timer still covers them.

## Notes and limitations

- The plugin reads the local filesystem of the machine running the CLI. With a
  remote OpenCode server, the project directory must also exist on the client.
- The commands run inside the TUI. The plugin API does not add `opencode todos`
  shell subcommands.
- Two TUI instances editing the same file use last-writer-wins semantics; there
  is no cross-process lock.
- The panel is read-mostly: clicking the header collapses it; clicking a TODO
  does not remove or reorder it.
- The sidebar can be hidden by a narrow terminal or by
  `session.sidebar: "hide"`.

## Development

The data layer has no OpenTUI dependencies and can be tested directly:

```sh
npm test
# or
bun test/todos.test.mjs
```

The suite covers parsing, serialization, `add`/`push`/`pop`, project-root
resolution, file creation, atomic-write cleanup, and missing-directory errors.

For manual TUI testing, symlink the package into
`~/.config/opencode/plugins/todos`, restart the TUI, and try:

```text
/todos add first
/todos push urgent
/todos pop
```

## License

MIT
