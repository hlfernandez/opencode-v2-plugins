import { execFile } from "node:child_process"

export type ChangeCode = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "?"

export type Change = {
  path: string
  code: ChangeCode
  from?: string
}

export type Commit = {
  hash: string
  subject: string
  time: number
}

export type GitState = {
  repo: boolean
  branch: string
  detached: boolean
  commit: Commit | null
  modified: Change[]
  untracked: Change[]
}

export type Status = Pick<GitState, "repo" | "branch" | "detached" | "modified" | "untracked">

export function empty(): GitState {
  return { repo: false, branch: "", detached: false, commit: null, modified: [], untracked: [] }
}

function codeOf(xy: string): ChangeCode {
  const index = xy[0] ?? "."
  const worktree = xy[1] ?? "."
  if (index === "U" || worktree === "U") return "U"
  if (index === "R" || worktree === "R") return "R"
  if (index === "C" || worktree === "C") return "C"
  if (index === "T" || worktree === "T") return "T"
  if (index === "A") return "A"
  if (index === "D" || worktree === "D") return "D"
  return "M"
}

// Parses `git status --porcelain=v2 --branch -z`. Records are NUL-separated;
// rename/copy records carry the original path as the next token, so the loop
// consumes it to keep it out of the file lists.
export function parseStatus(text: string): Status {
  const state: Status = { repo: true, branch: "", detached: false, modified: [], untracked: [] }
  const tokens = text.split("\0")

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!token) continue

    if (token.startsWith("# branch.head ")) {
      const head = token.slice("# branch.head ".length).trim()
      state.detached = head === "(detached)"
      state.branch = state.detached ? "detached" : head
      continue
    }
    if (token.startsWith("#")) continue

    const kind = token[0]
    if (kind === "?") {
      const path = token.slice(2)
      if (path) state.untracked.push({ path, code: "?" })
      continue
    }
    if (kind === "!") continue

    if (kind === "1") {
      const parts = token.split(" ")
      const xy = parts[1] ?? ".."
      const path = parts.slice(8).join(" ")
      if (path && xy !== "..") state.modified.push({ path, code: codeOf(xy) })
      continue
    }

    if (kind === "2") {
      const parts = token.split(" ")
      const xy = parts[1] ?? ".."
      const path = parts.slice(9).join(" ")
      const from = tokens[++index]
      if (path && xy !== "..") state.modified.push({ path, code: codeOf(xy), from })
      continue
    }

    if (kind === "u") {
      const parts = token.split(" ")
      const path = parts.slice(10).join(" ")
      if (path) state.modified.push({ path, code: "U" })
    }
  }

  state.modified.sort((left, right) => left.path.localeCompare(right.path))
  state.untracked.sort((left, right) => left.path.localeCompare(right.path))
  return state
}

export function parseCommit(text: string): Commit | null {
  const [hash, subject, timestamp] = text.trim().split("\x1f")
  if (!hash) return null
  const time = Number(timestamp)
  return { hash, subject: subject ?? "", time: Number.isFinite(time) ? time : 0 }
}

export function relativeTime(seconds: number, now = Date.now()): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ""
  const delta = Math.max(0, Math.floor(now / 1000) - Math.floor(seconds))
  if (delta < 60) return "just now"
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  if (delta < 604800) return `${Math.floor(delta / 86400)}d ago`
  if (delta < 2592000) return `${Math.floor(delta / 604800)}w ago`
  if (delta < 31536000) return `${Math.floor(delta / 2592000)}mo ago`
  return `${Math.floor(delta / 31536000)}y ago`
}

export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/")
  if (index <= 0 || index === path.length - 1) return { dir: "", name: path }
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

function options(cwd: string) {
  return {
    cwd,
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, options(cwd), (error, stdout) => {
      resolve(error ? null : String(stdout))
    })
  })
}

export async function read(cwd: string): Promise<GitState> {
  if (!cwd) return empty()

  const [status, log] = await Promise.all([
    git(cwd, [
      "-c",
      "status.relativePaths=false",
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=normal",
    ]),
    git(cwd, ["log", "-1", "--format=%h%x1f%s%x1f%ct"]),
  ])

  if (status === null) return empty()
  return { ...parseStatus(status), commit: log ? parseCommit(log) : null }
}
