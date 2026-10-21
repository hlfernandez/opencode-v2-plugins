/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { empty, read, relativeTime, splitPath, type Change, type ChangeCode, type GitState } from "./data.ts"

function sessionDirectory(context: Plugin.Context, sessionID?: string) {
  const session = sessionID ? context.data.session.get(sessionID) : undefined
  return (
    session?.location?.directory ||
    context.location?.directory ||
    context.data.location.default()?.directory ||
    ""
  )
}

function changeColor(theme: Plugin.Context["theme"], code: ChangeCode) {
  if (code === "A") return theme.text.feedback.success.base
  if (code === "D" || code === "U") return theme.text.feedback.error.base
  if (code === "R" || code === "C") return theme.text.feedback.info.base
  if (code === "?") return theme.text.muted
  return theme.text.feedback.warning.base
}

function ChangeRow(props: { context: Plugin.Context; change: Change }) {
  const theme = () => props.context.theme
  const path = () => splitPath(props.change.path)

  return (
    <box flexDirection="row" gap={1} paddingLeft={2} minWidth={0}>
      <text flexShrink={0} style={{ fg: changeColor(theme(), props.change.code) }}>
        {props.change.code}
      </text>
      <text wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
        <span style={{ fg: theme().text.muted }}>{path().dir}</span>
        <span style={{ fg: theme().text.base }}>{path().name}</span>
      </text>
    </box>
  )
}

function ListSection(props: { context: Plugin.Context; title: string; items: Change[]; maxFiles: number }) {
  const theme = () => props.context.theme
  const shown = () => (props.maxFiles > 0 ? props.items.slice(0, props.maxFiles) : props.items)
  const hidden = () => Math.max(0, props.items.length - shown().length)

  return (
    <Show when={props.items.length > 0}>
      <text fg={theme().text.muted}>
        <b>{props.title}</b> ({props.items.length})
      </text>
      <For each={shown()}>{(change) => <ChangeRow context={props.context} change={change} />}</For>
      <Show when={hidden() > 0}>
        <text fg={theme().text.muted} paddingLeft={2}>
          +{hidden()} more
        </text>
      </Show>
    </Show>
  )
}

function Panel(props: {
  context: Plugin.Context
  state: () => GitState
  sessionID: string
  follow: (sessionID?: string) => void
  open: boolean
  toggle: () => void
  maxFiles: number
}) {
  const theme = () => props.context.theme
  const state = () => props.state()
  const commit = () => state().commit
  const branch = () => state().branch || "HEAD"
  const total = () => state().modified.length + state().untracked.length
  const clean = () => total() === 0

  createEffect(() => props.follow(props.sessionID))

  return (
    <Show when={state().repo}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} onMouseDown={props.toggle} minWidth={0}>
          <text flexShrink={0} fg={theme().text.muted}>
            {props.open ? "▼" : "▶"}
          </text>
          <text flexShrink={0} fg={theme().text.base}>
            <b>Git</b>
          </text>
          <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate fg={theme().hue.accent[500]}>
            {branch()}
          </text>
          <text flexShrink={0} fg={theme().text.muted}>
            ({total()})
          </text>
        </box>
        <Show when={props.open}>
          <Show when={commit()} fallback={<text fg={theme().text.muted}>No commits yet</text>}>
            {(value) => (
              <>
                <text wrapMode="none" truncate>
                  <span style={{ fg: theme().text.feedback.warning.base }}>{value().hash}</span>
                  <span style={{ fg: theme().text.base }}> {value().subject || "(no subject)"}</span>
                </text>
                <text fg={theme().text.muted}>{relativeTime(value().time)}</text>
              </>
            )}
          </Show>
          <ListSection context={props.context} title="Modified" items={state().modified} maxFiles={props.maxFiles} />
          <ListSection context={props.context} title="New" items={state().untracked} maxFiles={props.maxFiles} />
          <Show when={clean() && commit()}>
            <text fg={theme().text.feedback.success.base}>✓ Working tree clean</text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "hlfernandez.git-panel",
  setup(context) {
    if (context.options.enabled === false) return

    const configuredInterval = typeof context.options.interval === "number" ? context.options.interval : 0
    const interval = configuredInterval >= 500 ? configuredInterval : 2500
    const configuredMax = typeof context.options.maxFiles === "number" ? Math.floor(context.options.maxFiles) : 5
    const maxFiles = configuredMax >= 0 ? Math.min(configuredMax, 50) : 5

    const [state, setState] = createSignal<GitState>(empty())
    const [view, setView] = context.storage.store("view", { initial: { open: true } })
    const [directory, setDirectory] = createSignal("")

    let currentDirectory = ""
    let pending = false
    let queued = false
    let disposed = false

    const refresh = (target = directory()) => {
      if (disposed || !target) return
      if (pending) {
        queued = true
        return
      }

      pending = true
      read(target)
        .then((next) => {
          if (!disposed && directory() === target) setState(next)
        })
        .catch(() => {})
        .finally(() => {
          pending = false
          if (!disposed && queued) {
            queued = false
            refresh()
          }
        })
    }

    let debounce: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = undefined
        refresh()
      }, 200)
    }

    const follow = (sessionID?: string) => {
      if (disposed) return
      const next = sessionDirectory(context, sessionID)
      if (next === currentDirectory) return
      currentDirectory = next
      setDirectory(next)
      refresh(next)
    }

    const toggle = () => {
      Promise.resolve(
        setView((draft) => {
          draft.open = !draft.open
        }),
      ).catch(() => {})
    }

    const timer = setInterval(() => refresh(), interval)

    const offs: (() => void)[] = []
    for (const type of [
      "filesystem.changed",
      "vcs.branch.updated",
      "session.idle",
      "worktree.resolved",
      "worktree.updated",
    ] as const) {
      try {
        offs.push(context.data.on(type, schedule))
      } catch {
        // Event type unavailable on this host version; polling still covers it.
      }
    }

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <Panel
          context={context}
          state={state}
          sessionID={input.sessionID}
          follow={follow}
          open={view.open}
          toggle={toggle}
          maxFiles={maxFiles}
        />
      ),
    })

    return () => {
      disposed = true
      clearInterval(timer)
      if (debounce) clearTimeout(debounce)
      for (const off of offs) off()
    }
  },
})
