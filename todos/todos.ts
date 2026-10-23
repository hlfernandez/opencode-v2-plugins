import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export type TodosState = {
  file: string
  root: string
  exists: boolean
  missing: boolean
  todos: string[]
}

export type Mutation =
  | { type: "add"; text: string }
  | { type: "push"; text: string }
  | { type: "pop" }

export type MutationResult = TodosState & {
  removed?: string
}

export class TodosError extends Error {
  readonly code: "missing" | "empty"

  constructor(message: string, code: "missing" | "empty") {
    super(message)
    this.name = "TodosError"
    this.code = code
  }
}

export function empty(): TodosState {
  return { file: "", root: "", exists: false, missing: false, todos: [] }
}

export function parse(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function serialize(todos: readonly string[]): string {
  return todos.length > 0 ? `${todos.join("\n")}\n` : ""
}

export function normalizeText(value: string): string {
  return value.replace(/\r?\n/g, " ").trim()
}

function todoText(value: string): string {
  const text = normalizeText(value)
  if (!text) throw new TodosError("Todo text is required", "empty")
  return text
}

export function add(todos: readonly string[], text: string): string[] {
  return [...todos, todoText(text)]
}

export function push(todos: readonly string[], text: string): string[] {
  return [todoText(text), ...todos]
}

export function pop(todos: readonly string[]): { todos: string[]; removed?: string } {
  if (todos.length === 0) return { todos: [] }
  return { todos: todos.slice(1), removed: todos[0] }
}

// The canonical checkout is the project root when OpenCode knows it; otherwise
// the session directory is used. This keeps worktrees on the main checkout's
// list and avoids surprising parent directories (such as ~/.opencode).
export function resolveRoot(directory: string, canonical?: string): string {
  const base = canonical?.trim() ? canonical : directory
  return base ? resolve(base) : ""
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as { code?: unknown }).code
  return code === "ENOENT" || code === "ENOTDIR"
}

export async function read(directory: string, canonical?: string): Promise<TodosState> {
  const root = resolveRoot(directory, canonical)
  if (!root) return empty()

  const file = join(root, ".opencode", "todos.txt")
  if (!(await isDirectory(root))) {
    return { file, root, exists: false, missing: true, todos: [] }
  }

  try {
    const text = await readFile(file, "utf8")
    return { file, root, exists: true, missing: false, todos: parse(text) }
  } catch (error) {
    if (isNotFound(error)) {
      return { file, root, exists: false, missing: false, todos: [] }
    }
    throw error
  }
}

export async function write(file: string, todos: readonly string[]): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true })

  const temporary = join(directory, `.todos-${process.pid}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, serialize(todos), "utf8")
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function mutate(
  directory: string,
  canonical: string | undefined,
  mutation: Mutation,
): Promise<MutationResult> {
  const current = await read(directory, canonical)
  if (current.missing) {
    throw new TodosError(`Directory not found: ${current.root || directory}`, "missing")
  }

  if (mutation.type === "pop") {
    const result = pop(current.todos)
    if (result.todos.length === current.todos.length) return { ...current }
    await write(current.file, result.todos)
    return { ...current, exists: true, todos: result.todos, removed: result.removed }
  }

  const todos = mutation.type === "add" ? add(current.todos, mutation.text) : push(current.todos, mutation.text)
  await write(current.file, todos)
  return { ...current, exists: true, todos }
}
