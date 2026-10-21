// Smoke test for the git-panel data layer.
//
// The parser is fed the exact records `git status --porcelain=v2 -z` emits,
// then a throwaway repository verifies the end-to-end read path.
//
//   npm test         (node --experimental-strip-types test/smoke.mjs)
//   bun test/smoke.mjs

import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseCommit,
  parseProjectConfig,
  parseStatus,
  projectDirectory,
  read,
  relativeTime,
  resolveConfiguredDirectory,
  splitPath,
} from "../data.ts"

let failures = 0

function check(name, condition, extra = "") {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

console.log("status parser")

const status = [
  "# branch.oid abc123",
  "# branch.head main",
  "1 .M N... 100644 100644 100644 abc def src/a.ts",
  "1 A. N... 100644 000000 000000 abc 000 src/new.ts",
  "2 R. N... 100644 100644 100644 abc def R100 src/renamed.ts",
  "src/old.ts",
  "u UU N... 100644 100644 100644 100644 abc def ghi src/conflict.ts",
  "? notes/new file.md",
].join("\0")

const parsed = parseStatus(`${status}\0`)
const byPath = Object.fromEntries(parsed.modified.map((change) => [change.path, change]))

check("branch", parsed.branch === "main" && parsed.detached === false, parsed.branch)
check("modified count", parsed.modified.length === 4, JSON.stringify(parsed.modified))
check("unstaged modification", byPath["src/a.ts"]?.code === "M", JSON.stringify(byPath["src/a.ts"]))
check("staged addition", byPath["src/new.ts"]?.code === "A", JSON.stringify(byPath["src/new.ts"]))
check(
  "rename keeps the new path and the original",
  byPath["src/renamed.ts"]?.code === "R" && byPath["src/renamed.ts"]?.from === "src/old.ts",
  JSON.stringify(byPath["src/renamed.ts"]),
)
check("rename original is not a separate row", !byPath["src/old.ts"])
check("conflict", byPath["src/conflict.ts"]?.code === "U", JSON.stringify(byPath["src/conflict.ts"]))
check(
  "untracked path with spaces",
  parsed.untracked.length === 1 && parsed.untracked[0].path === "notes/new file.md",
  JSON.stringify(parsed.untracked),
)

const detached = parseStatus("# branch.head (detached)\0")
check("detached state", detached.detached === true && detached.branch === "detached", detached.branch)

const deleted = parseStatus("1 .D N... 100644 100644 000000 abc def gone.ts\0")
check("unstaged deletion", deleted.modified[0]?.code === "D", JSON.stringify(deleted.modified))

console.log("commit parser")

const commit = parseCommit("8cd8f3f\x1fdocs: test subject\x1f1700000000\n")
check(
  "hash, subject and timestamp",
  commit?.hash === "8cd8f3f" && commit?.subject === "docs: test subject" && commit?.time === 1700000000,
  JSON.stringify(commit),
)
check("empty log output", parseCommit("") === null)

console.log("relative time")

const now = 1_700_000_000_000
const ago = (seconds) => relativeTime(now / 1000 - seconds, now)

check("seconds", ago(10) === "just now", ago(10))
check("minutes", ago(65) === "1m ago", ago(65))
check("hours", ago(2 * 3600) === "2h ago", ago(2 * 3600))
check("days", ago(3 * 86400) === "3d ago", ago(3 * 86400))
check("weeks", ago(14 * 86400) === "2w ago", ago(14 * 86400))
check("months", ago(60 * 86400) === "2mo ago", ago(60 * 86400))
check("years", ago(400 * 86400) === "1y ago", ago(400 * 86400))
check("future timestamps clamp", relativeTime(now / 1000 + 100, now) === "just now")
check("missing timestamp", relativeTime(0, now) === "")

console.log("path split")

check("nested path", splitPath("a/b/c.ts").dir === "a/b/" && splitPath("a/b/c.ts").name === "c.ts")
check("root file", splitPath("README.md").dir === "" && splitPath("README.md").name === "README.md")
check("untracked directory", splitPath("newdir/").dir === "" && splitPath("newdir/").name === "newdir/")

console.log("project config")

check("absolute directory", resolveConfiguredDirectory("/srv/repo", "/home/me/project") === "/srv/repo")
check("absolute directory normalised", resolveConfiguredDirectory("/srv/./repo", "/base") === "/srv/repo")
check("relative directory", resolveConfiguredDirectory("../other", "/home/me/project") === "/home/me/other")
check("home directory", resolveConfiguredDirectory("~/src/repo", "/base") === join(homedir(), "src/repo"))
check("bare home", resolveConfiguredDirectory("~", "/base") === homedir())
check("config directory value", parseProjectConfig('{ "directory": " ../repo " }') === "../repo")
check("config ignores invalid json", parseProjectConfig("{ nope") === undefined)
check("config ignores non-string", parseProjectConfig('{ "directory": 42 }') === undefined)
check("config ignores empty value", parseProjectConfig('{ "directory": "  " }') === undefined)
check("config ignores missing key", parseProjectConfig("{}") === undefined)

console.log("git integration")

const dir = await mkdtemp(join(tmpdir(), "git-panel-test-"))
const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })

try {
  git("init", "-q")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")

  const sub = join(dir, "sub")
  await mkdir(sub)
  await writeFile(join(dir, "a.txt"), "one\n")
  await writeFile(join(dir, "keep.txt"), "keep\n")
  await writeFile(join(sub, "tracked.txt"), "tracked\n")
  git("add", "-A")
  git("commit", "-qm", "initial commit")

  await writeFile(join(dir, "a.txt"), "two\n")
  await writeFile(join(sub, "tracked.txt"), "changed\n")
  await writeFile(join(sub, "new.txt"), "new\n")
  await writeFile(join(dir, "b.txt"), "new\n")

  const state = await read(dir)
  check("repository detected", state.repo === true)
  check("branch present", Boolean(state.branch) && !state.detached, state.branch)
  check("latest commit subject", state.commit?.subject === "initial commit", JSON.stringify(state.commit))
  check("latest commit has a relative time", Boolean(state.commit && relativeTime(state.commit.time)))
  check(
    "tracked modification",
    state.modified.some((change) => change.path === "a.txt" && change.code === "M"),
    JSON.stringify(state.modified),
  )
  check(
    "untracked file",
    state.untracked.some((change) => change.path === "b.txt"),
    JSON.stringify(state.untracked),
  )

  const fromSub = await read(sub)
  check(
    "subdirectory sees root-relative untracked paths",
    fromSub.untracked.some((change) => change.path === "sub/new.txt"),
    JSON.stringify(fromSub.untracked),
  )
  check(
    "subdirectory still sees root changes",
    fromSub.modified.some((change) => change.path === "a.txt") &&
      fromSub.modified.some((change) => change.path === "sub/tracked.txt"),
    JSON.stringify(fromSub.modified),
  )

  git("mv", "keep.txt", "moved.txt")
  const renamed = await read(dir)
  const rename = renamed.modified.find((change) => change.path === "moved.txt")
  check("rename record", rename?.code === "R" && rename?.from === "keep.txt", JSON.stringify(rename))

  git("add", "-A")
  git("commit", "-qm", "second commit")
  const clean = await read(dir)
  check(
    "clean tree",
    clean.modified.length === 0 && clean.untracked.length === 0,
    JSON.stringify({ modified: clean.modified, untracked: clean.untracked }),
  )
  check("latest commit follows HEAD", clean.commit?.subject === "second commit", JSON.stringify(clean.commit))

  const missing = await read(join(dir, "does-not-exist"))
  check("missing directory is not a repository", missing.repo === false && missing.modified.length === 0)

  const project = join(dir, "project")
  const app = join(project, "packages", "app")
  const other = join(dir, "other")
  const worktree = join(dir, "worktree")
  await mkdir(app, { recursive: true })
  await mkdir(join(project, ".opencode"), { recursive: true })
  await mkdir(other)
  await mkdir(worktree)

  const gitOther = (...args) => execFileSync("git", ["-C", other, ...args], { stdio: "ignore" })
  gitOther("init", "-q")
  gitOther("config", "user.email", "test@example.com")
  gitOther("config", "user.name", "Test")
  await writeFile(join(other, "x.txt"), "x\n")
  gitOther("add", "-A")
  gitOther("commit", "-qm", "other repo")

  const configFile = join(project, ".opencode", "git-panel.json")
  await writeFile(configFile, '{ "directory": "../other" }')

  const relative = await projectDirectory(app)
  check(
    "relative override resolves from the project root",
    relative.directory === other && relative.source === "project" && relative.name === "other" && !relative.missing,
    JSON.stringify(relative),
  )

  const overridden = await read(relative.directory)
  check("override target is read", overridden.repo && overridden.commit?.subject === "other repo", JSON.stringify(overridden.commit))

  await writeFile(configFile, JSON.stringify({ directory: other }))
  const absolute = await projectDirectory(app)
  check("absolute override", absolute.directory === other && absolute.missing === false, JSON.stringify(absolute))

  await writeFile(configFile, '{ "directory": "../missing-dir" }')
  const missingTarget = await projectDirectory(app)
  check(
    "missing override target is reported",
    missingTarget.source === "project" && missingTarget.missing === true,
    JSON.stringify(missingTarget),
  )

  await mkdir(join(app, ".opencode"), { recursive: true })
  await writeFile(join(app, ".opencode", "git-panel.json"), '{ "directory": "../../.." }')
  const nearest = await projectDirectory(app)
  check("nearest config wins", nearest.directory === dir, JSON.stringify(nearest))

  await writeFile(configFile, '{ "directory": "../other" }')
  const inherited = await projectDirectory(worktree, project)
  check("worktree inherits the canonical config", inherited.directory === other, JSON.stringify(inherited))

  const plain = await projectDirectory(dir)
  check(
    "no config keeps the session directory",
    plain.source === "session" && plain.directory === dir,
    JSON.stringify(plain),
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log("\nsmoke ok")
