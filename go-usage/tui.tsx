/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import {
  createDebouncer,
  describeError,
  fetchUsage,
  formatAgo,
  formatCountdown,
  formatPercent,
  formatResetAt,
  remaining,
  selectApiKey,
  settle,
  UsageError,
  type GoUsage,
  type PanelState,
  type WindowName,
} from "./usage.ts"

const WINDOWS: { key: WindowName; label: string }[] = [
  { key: "rolling", label: "Rolling" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
]

function remainingColor(theme: Plugin.Context["theme"], percent: number) {
  const left = remaining(percent)
  if (left <= 5) return theme.text.feedback.error.base
  if (left <= 20) return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

function Panel(props: {
  context: Plugin.Context
  state: () => PanelState
  loading: () => boolean
  envName: string
  open: boolean
  toggle: () => void
}) {
  const theme = () => props.context.theme
  const state = () => props.state()
  const updated = () => (state().fetchedAt ? `Updated ${formatAgo(state().fetchedAt!)}` : "")

  return (
    <Show when={state().usage || state().error || props.loading()}>
      <box flexDirection="column" flexShrink={0}>
        <box flexDirection="row" gap={1} onMouseDown={props.toggle} minWidth={0}>
          <text flexShrink={0} fg={theme().text.muted}>
            {props.open ? "▼" : "▶"}
          </text>
          <text flexShrink={0} fg={theme().text.base}>
            <b>Go Usage</b>
          </text>
          <Show when={state().stale}>
            <text flexShrink={0} fg={theme().text.feedback.warning.base}>
              ⚠
            </text>
          </Show>
        </box>
        <Show when={props.open}>
          <Show
            when={state().usage}
            fallback={
              <>
                <text fg={theme().text.feedback.warning.base}>{state().error ?? "Loading…"}</text>
                <Show when={state().error === "No OpenCode Go key found"}>
                  <text fg={theme().text.muted}>Sign in to OpenCode Go or set {props.envName}</text>
                </Show>
              </>
            }
          >
            {(usage) => (
              <>
                <For each={WINDOWS}>
                  {(window) => {
                    const value = () => usage()[window.key]
                    return (
                      <box flexDirection="row" gap={1} minWidth={0}>
                        <text flexShrink={0} fg={theme().text.muted}>
                          {window.label}
                        </text>
                        <text flexShrink={0} fg={remainingColor(theme(), value().percent)}>
                          {formatPercent(remaining(value().percent))} left
                        </text>
                        <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate fg={theme().text.muted}>
                          · {formatCountdown(value().resetsAt)} ({formatResetAt(value().resetsAt)})
                        </text>
                      </box>
                    )
                  }}
                </For>
                <text
                  flexShrink={0}
                  wrapMode="none"
                  truncate
                  fg={state().stale ? theme().text.feedback.warning.base : theme().text.muted}
                >
                  {state().stale ? `⚠ ${state().error ?? "Refresh failed"} · ${updated()}` : updated()}
                </text>
              </>
            )}
          </Show>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "hlfernandez.go-usage",
  setup(context) {
    if (context.options.enabled === false) return

    const configuredInterval = typeof context.options.interval === "number" ? context.options.interval : 0
    const interval = configuredInterval >= 5000 ? configuredInterval : 60000
    const configuredEnv = typeof context.options.apiKeyEnv === "string" ? context.options.apiKeyEnv.trim() : ""
    const envName = configuredEnv || "OPENCODE_GO_API_KEY"

    const [state, setState] = createSignal<PanelState>({ stale: false })
    const [loading, setLoading] = createSignal(true)
    const [view, setView] = context.storage.store("view", { initial: { open: true } })

    let disposed = false
    let pending = false
    let queued = false
    let cachedKey: string | undefined
    let cachedSource: "env" | "credential" | undefined

    const keyFor = async (refresh: boolean): Promise<string | undefined> => {
      if (refresh) cachedKey = undefined

      const fromEnv = process.env[envName]?.trim()
      if (fromEnv) {
        cachedKey = fromEnv
        cachedSource = "env"
        return fromEnv
      }
      if (cachedKey && cachedSource === "credential") return cachedKey

      try {
        const entries = await context.client.credential.list()
        const result = selectApiKey({ envName, credentials: entries })
        cachedKey = result.key
        cachedSource = result.source
        return result.key
      } catch {
        return undefined
      }
    }

    const refresh = async (options: { refreshKey?: boolean } = {}) => {
      if (disposed) return
      if (pending) {
        queued = true
        return
      }

      pending = true
      try {
        const key = await keyFor(options.refreshKey === true)
        if (disposed) return

        if (!key) {
          setState(settle(state(), { ok: false, error: "No OpenCode Go key found" }, Date.now()))
          return
        }

        const usage = await fetchUsage(key)
        if (disposed) return
        setState(settle(state(), { ok: true, usage }, Date.now()))
      } catch (error) {
        if (disposed) return
        if (error instanceof UsageError && error.status === 401 && cachedSource === "credential") cachedKey = undefined
        setState(settle(state(), { ok: false, error: describeError(error) }, Date.now()))
      } finally {
        pending = false
        setLoading(false)
        if (!disposed && queued) {
          queued = false
          void refresh()
        }
      }
    }

    const debounced = createDebouncer(750, () => void refresh())
    const rekey = () => {
      cachedKey = undefined
      debounced.schedule()
    }

    const toggle = () => {
      Promise.resolve(
        setView((draft) => {
          draft.open = !draft.open
        }),
      ).catch(() => {})
    }

    const offs: (() => void)[] = []
    try {
      offs.push(context.data.on("session.idle", debounced.schedule))
    } catch {
      // Event type unavailable on this host version; the timer still covers it.
    }
    for (const type of ["credential.updated", "credential.switched"] as const) {
      try {
        offs.push(context.data.on(type, rekey))
      } catch {
        // Event type unavailable on this host version.
      }
    }

    const timer = setInterval(() => void refresh(), interval)

    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Panel context={context} state={state} loading={loading} envName={envName} open={view.open} toggle={toggle} />
      ),
    })

    void refresh()

    return () => {
      disposed = true
      clearInterval(timer)
      debounced.cancel()
      for (const off of offs) off()
    }
  },
})
