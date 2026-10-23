// Smoke test for the todos data layer.
//
//   npm test         (node --experimental-strip-types test/todos.test.mjs)
//   bun test/todos.test.mjs

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  add,
  empty,
  mutate,
  normalizeText,
  parse,
  pop,
  push,
  read,
  resolveRoot,
  serialize,
  TodosError,
  write,
} from "../todos.ts"

let failures = 0

function check(name, condition, extra = "") {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

function throws(name, fn) {
  try {
    fn()
    check(name, false, "did not throw")
  } catch (error) {
    check(name, error instanceof TodosError && error.code === "empty", String(error))
  }
}

console.log("parsing")

check("one todo per line", JSON.stringify(parse("first\nsecond\nthird\n")) === JSON.stringify(["first", "second", "third"]))
check("blank lines are ignored", JSON.stringify(parse("\nfirst\n\n second \n")) === JSON.stringify(["first", "second"]))
check("CRLF is accepted", JSON.stringify(parse("first\r\nsecond\r\n")) === JSON.stringify(["first", "second"]))
check("internal spacing is preserved", parse("a  b\n")[0] === "a  b")
check("empty input", parse("").length === 0)
check("whitespace-only input", parse("  \n\t\n").length === 0)

console.log("serializing")

check("trailing newline", serialize(["first", "second"]) === "first\nsecond\n")
check("empty list", serialize([]) === "")
check("empty state", empty().todos.length === 0 && empty().exists === false)

console.log("text normalization")

check("trim", normalizeText("  buy milk  ") === "buy milk")
check("line breaks become spaces", normalizeText("one\ntwo") === "one two")
check("internal spacing kept", normalizeText("one  two") === "one  two")

console.log("stack operations")

check("add appends", JSON.stringify(add(["first"], "second")) === JSON.stringify(["first", "second"]))
check("push prepends", JSON.stringify(push(["first"], "second")) === JSON.stringify(["second", "first"]))
check("add keeps input untouched", add([], "  first  ")[0] === "first")
check("push keeps input untouched", push([], "  first  ")[0] === "first")

const popped = pop(["first", "second"])
check("pop removes the first item", JSON.stringify(popped.todos) === JSON.stringify(["second"]) && popped.removed === "first")
const emptyPop = pop([])
check("pop on empty keeps the list empty", emptyPop.todos.length === 0 && emptyPop.removed === undefined)

throws("add rejects empty text", () => add([], "   "))
throws("add rejects whitespace", () => add([], "\n\t\n"))
throws("push rejects empty text", () => push([], ""))

console.log("root resolution")

check("canonical wins", resolveRoot("/repo/sub", "/repo") === "/repo")
check("session directory is the fallback", resolveRoot("/repo/sub", undefined) === "/repo/sub")
check("no directory", resolveRoot("", undefined) === "")

console.log("file integration")

const dir = await mkdtemp(join(tmpdir(), "todos-test-"))
const project = join(dir, "project")
const nested = join(project, "packages", "app")
const file = join(project, ".opencode", "todos.txt")

try {
  await mkdir(nested, { recursive: true })

  const missing = await read(nested, project)
  check("missing file is reported", missing.exists === false && missing.missing === false, JSON.stringify(missing))
  check("missing file path is in the project root", missing.file === file, missing.file)

  const added = await mutate(nested, project, { type: "add", text: "  first  " })
  check("add creates the file", added.exists === true && added.todos[0] === "first", JSON.stringify(added))
  check("add writes a trailing newline", (await readFile(file, "utf8")) === "first\n")

  const pushed = await mutate(nested, project, { type: "push", text: "zero" })
  check("push prepends on disk", JSON.stringify(pushed.todos) === JSON.stringify(["zero", "first"]))
  check("push writes both items", (await readFile(file, "utf8")) === "zero\nfirst\n")

  const poppedState = await mutate(nested, project, { type: "pop" })
  check("pop removes the first item on disk", poppedState.removed === "zero" && JSON.stringify(poppedState.todos) === JSON.stringify(["first"]))
  check("pop rewrites the file", (await readFile(file, "utf8")) === "first\n")

  const emptyState = await mutate(nested, project, { type: "pop" })
  check("pop removes the last item", emptyState.removed === "first" && emptyState.todos.length === 0)
  check("empty file exists", emptyState.exists === true && (await readFile(file, "utf8")) === "")

  const noMore = await mutate(nested, project, { type: "pop" })
  check("pop on an empty file is a no-op", noMore.removed === undefined && noMore.todos.length === 0)

  await writeFile(file, "  alpha  \r\nbeta\r\n\r\n", "utf8")
  const parsed = await read(nested, project)
  check("reads and normalizes an existing file", JSON.stringify(parsed.todos) === JSON.stringify(["alpha", "beta"]))

  await write(file, [])
  check("write can empty a file", (await readFile(file, "utf8")) === "")

  const sessionOnly = await read(nested)
  check("no canonical uses the session directory", sessionOnly.root === nested && sessionOnly.file === join(nested, ".opencode", "todos.txt"))

  const missingRoot = await read(join(dir, "does-not-exist"), join(dir, "does-not-exist"))
  check("missing project root", missingRoot.missing === true && missingRoot.exists === false, JSON.stringify(missingRoot))

  let missingError
  try {
    await mutate(join(dir, "does-not-exist"), join(dir, "does-not-exist"), { type: "add", text: "x" })
  } catch (error) {
    missingError = error
  }
  check(
    "mutating a missing root throws a missing error",
    missingError instanceof TodosError && missingError.code === "missing",
    String(missingError),
  )

  const leftovers = (await readdir(join(project, ".opencode"))).filter((name) => name.endsWith(".tmp"))
  check("no temporary files remain", leftovers.length === 0, JSON.stringify(leftovers))
} finally {
  await rm(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log("\nsmoke ok")
