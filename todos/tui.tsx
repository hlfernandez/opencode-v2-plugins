/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, For, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { empty, mutate, read, type Mutation, type TodosState } from "./todos.ts"

type ToastVariant = "info" | "success" | "warning" | "error"

function describe(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unexpected error"
}

function Panel(props: {
  context: Plugin.Context
  state: () => TodosState
  notice: () => string | undefined
  sessionID: string
  follow: (sessionID?: string) => void
  open: boolean
  toggle: () => void
  maxItems: number
}) {
  const theme = () => props.context.theme
  const state = () => props.state()
  const todos = () => state().todos
  const shown = () => (props.maxItems > 0 ? todos().slice(0, props.maxItems) : todos())
  const hidden = () => Math.max(0, todos().length - shown().length)

  createEffect(() => props.follow(props.sessionID))

  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" gap={1} onMouseDown={props.toggle} minWidth={0}>
        <text flexShrink={0} fg={theme().text.muted}>
          {props.open ? "▼" : "▶"}
        </text>
        <text flexShrink={0} fg={theme().text.base}>
          <b>TODOs</b>
        </text>
        <text flexShrink={0} fg={theme().text.muted}>
          ({todos().length})
        </text>
      </box>
      <Show when={props.open}>
        <For each={shown()}>
          {(todo, index) => (
            <box flexDirection="row" gap={1} paddingLeft={2} minWidth={0}>
              <text flexShrink={0} fg={theme().text.muted}>
                {index() + 1}.
              </text>
              <text
                wrapMode="none"
                truncate
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                fg={index() === 0 ? theme().hue.accent[500] : theme().text.base}
              >
                {todo}
              </text>
            </box>
          )}
        </For>
        <Show when={todos().length === 0 && !props.notice()}>
          <text fg={theme().text.muted} paddingLeft={2}>
            No todos yet
          </text>
        </Show>
        <Show when={hidden() > 0}>
          <text fg={theme().text.muted} paddingLeft={2}>
            +{hidden()} more
          </text>
        </Show>
        <Show when={props.notice()}>
          {(message) => (
            <text fg={theme().text.feedback.warning.base} paddingLeft={2}>
              {message()}
            </text>
          )}
        </Show>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "hlfernandez.todos",
  setup(context) {
    if (context.options.enabled === false) return

    const configuredInterval = typeof context.options.interval === "number" ? context.options.interval : 0
    const interval = configuredInterval >= 250 ? configuredInterval : 1000
    const configuredMax = typeof context.options.maxItems === "number" ? Math.floor(context.options.maxItems) : Number.NaN
    const maxItems = Number.isFinite(configuredMax) && configuredMax >= 0 ? Math.min(configuredMax, 200) : 10

    const [state, setState] = createSignal<TodosState>(empty())
    const [notice, setNotice] = createSignal<string | undefined>(undefined)
    const [view, setView] = context.storage.store("todos.view", { initial: { open: true } })

    let currentSession: string | undefined
    let requestToken = 0
    let pending = false
    let queued = false
    let disposed = false
    let debounce: ReturnType<typeof setTimeout> | undefined
    let writeTail: Promise<unknown> = Promise.resolve()

    void context.data.project.sync().catch(() => {})

    const sessionDirectory = (sessionID?: string) => {
      const session = sessionID ? context.data.session.get(sessionID) : undefined
      return (
        session?.location?.directory ||
        context.location?.directory ||
        context.data.location.default()?.directory ||
        ""
      )
    }

    const resolveTarget = async (sessionID?: string) => {
      const session = sessionID ? context.data.session.get(sessionID) : undefined
      let canonical = session?.projectID ? context.data.project.get(session.projectID)?.canonical : undefined
      if (session?.projectID && !canonical) {
        await context.data.project.sync().catch(() => {})
        canonical = context.data.project.get(session.projectID)?.canonical
      }
      return { directory: sessionDirectory(sessionID), canonical }
    }

    const sync = async () => {
      if (disposed) return
      if (pending) {
        queued = true
        return
      }

      pending = true
      const token = requestToken
      try {
        const { directory, canonical } = await resolveTarget(currentSession)
        if (disposed || token !== requestToken) return

        if (!directory) {
          setState(empty())
          setNotice(undefined)
          return
        }

        const next = await read(directory, canonical)
        if (disposed || token !== requestToken) return

        setState(next)
        setNotice(next.missing ? `Directory not found: ${context.ui.format.path(next.root || directory)}` : undefined)
      } catch (error) {
        if (disposed || token !== requestToken) return
        setNotice(describe(error))
      } finally {
        pending = false
        if (!disposed && queued) {
          queued = false
          void sync()
        }
      }
    }

    const schedule = () => {
      if (disposed) return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = undefined
        void sync()
      }, 150)
    }

    const follow = (sessionID?: string) => {
      if (disposed) return
      if (sessionID !== currentSession) {
        currentSession = sessionID
        requestToken++
      }
      void sync()
    }

    const toggle = () => {
      Promise.resolve(
        setView((draft) => {
          draft.open = !draft.open
        }),
      ).catch(() => {})
    }

    const toast = (message: string, variant: ToastVariant = "info") => {
      context.ui.toast.show({ title: "TODOs", message, variant })
    }

    const activeSession = () => {
      const route = context.ui.router.current()
      if (route.type === "session") return route.sessionID
      return currentSession
    }

    const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
      const next = writeTail.then(work, work)
      writeTail = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }

    const runMutation = (mode: "add" | "push" | "pop", text?: string) =>
      enqueue(async () => {
        try {
          const sessionID = activeSession()
          const { directory, canonical } = await resolveTarget(sessionID)
          if (disposed) return
          if (!directory) {
            toast("Open a session in a project first", "warning")
            return
          }

          const mutation: Mutation = mode === "pop" ? { type: "pop" } : { type: mode, text: text ?? "" }
          const next = await mutate(directory, canonical, mutation)
          if (disposed) return

          if (sessionID === activeSession()) {
            requestToken++
            setState(next)
            setNotice(next.missing ? `Directory not found: ${context.ui.format.path(next.root || directory)}` : undefined)
          }

          if (mode === "pop") {
            if (next.removed) toast(`Popped: ${next.removed}`, "success")
            else toast("No TODOs to pop", "info")
          } else {
            toast(mode === "add" ? "TODO added" : "TODO pushed to top", "success")
          }
        } catch (error) {
          if (!disposed) toast(describe(error), "error")
        }
      })

    const promptAndRun = async (mode: "add" | "push") => {
      const value = await context.ui.dialog.prompt({
        title: mode === "add" ? "Add TODO" : "Push TODO",
        description: mode === "add" ? "Added after the last TODO." : "Inserted at the top of the list.",
        placeholder: "What needs doing?",
      })
      if (value === undefined) return
      if (!value.trim()) {
        toast("Todo text is required", "warning")
        return
      }
      await runMutation(mode, value)
    }

    const usage = "Usage: /todos add|push <text> · /todos pop"
    const runSlash = async (input?: string) => {
      const raw = (input ?? "").trim()
      if (!raw) {
        toast(usage, "info")
        return
      }

      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
      const verb = match?.[1]?.toLowerCase()
      const text = (match?.[2] ?? "").trim()

      if (verb === "add" || verb === "push") {
        if (!text) {
          toast(`Usage: /todos ${verb} <text>`, "warning")
          return
        }
        await runMutation(verb, text)
        return
      }

      if (verb === "pop") {
        if (text) {
          toast("Usage: /todos pop", "warning")
          return
        }
        await runMutation("pop")
        return
      }

      toast(usage, "warning")
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "hlfernandez.todos",
          title: "Manage TODOs",
          group: "TODOs",
          slash: { name: "todos", arguments: true as const },
          run: (input) => runSlash(input),
        },
        {
          id: "hlfernandez.todos.add",
          title: "Add TODO at the end",
          group: "TODOs",
          palette: true,
          run: () => promptAndRun("add"),
        },
        {
          id: "hlfernandez.todos.push",
          title: "Push TODO to the top",
          group: "TODOs",
          palette: true,
          run: () => promptAndRun("push"),
        },
        {
          id: "hlfernandez.todos.pop",
          title: "Pop the first TODO",
          group: "TODOs",
          palette: true,
          run: () => runMutation("pop"),
        },
      ],
    }))

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <Panel
          context={context}
          state={state}
          notice={notice}
          sessionID={input.sessionID}
          follow={follow}
          open={view.open}
          toggle={toggle}
          maxItems={maxItems}
        />
      ),
    })

    const offs: (() => void)[] = []
    for (const type of ["filesystem.changed", "worktree.resolved", "worktree.updated"] as const) {
      try {
        offs.push(context.data.on(type, schedule))
      } catch {
        // Event type unavailable on this host version; polling still covers it.
      }
    }

    const timer = setInterval(() => void sync(), interval)
    void sync()

    return () => {
      disposed = true
      clearInterval(timer)
      if (debounce) clearTimeout(debounce)
      for (const off of offs) off()
    }
  },
})
