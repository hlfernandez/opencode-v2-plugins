// Smoke test for the go-usage data layer.
//
//   npm test         (node --experimental-strip-types test/usage.test.mjs)
//   bun test/usage.test.mjs

import {
  UsageError,
  createDebouncer,
  describeError,
  fetchUsage,
  formatAgo,
  formatCountdown,
  formatPercent,
  formatResetAt,
  parseUsage,
  remaining,
  selectApiKey,
  settle,
} from "../usage.ts"

let failures = 0

function check(name, condition, extra = "") {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`)
  }
}

const payload = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2026-10-23T12:08:13.000Z" },
    weekly: { status: "ok", percent: 5, resetsAt: "2026-10-26T00:00:00.000Z" },
    monthly: { status: "ok", percent: 4, resetsAt: "2026-11-15T12:59:07.000Z" },
  },
}

function throws(name, fn) {
  try {
    fn()
    check(name, false, "did not throw")
  } catch (error) {
    check(name, error instanceof UsageError && error.kind === "invalid", String(error))
  }
}

console.log("usage parser")

const parsed = parseUsage(payload)
check(
  "all three windows",
  parsed.rolling.percent === 0 &&
    parsed.weekly.percent === 5 &&
    parsed.monthly.percent === 4 &&
    parsed.weekly.resetsAt === "2026-10-26T00:00:00.000Z" &&
    parsed.weekly.status === "ok",
  JSON.stringify(parsed),
)

const decimal = parseUsage({ usage: { ...payload.usage, rolling: { percent: 12.5, resetsAt: payload.usage.rolling.resetsAt } } })
check("decimal percent accepted", decimal.rolling.percent === 12.5)
check("optional status omitted", decimal.rolling.status === undefined)

throws("missing usage", () => parseUsage({}))
throws("null payload", () => parseUsage(null))
throws("array payload", () => parseUsage([]))
throws("missing window", () => parseUsage({ usage: { rolling: payload.usage.rolling, weekly: payload.usage.weekly } }))
throws("non-object window", () => parseUsage({ usage: { ...payload.usage, monthly: 3 } }))
throws("percent below zero", () => parseUsage({ usage: { ...payload.usage, weekly: { percent: -1, resetsAt: payload.usage.weekly.resetsAt } } }))
throws("percent above 100", () => parseUsage({ usage: { ...payload.usage, weekly: { percent: 101, resetsAt: payload.usage.weekly.resetsAt } } }))
throws("percent as string", () => parseUsage({ usage: { ...payload.usage, weekly: { percent: "5", resetsAt: payload.usage.weekly.resetsAt } } }))
throws("missing reset date", () => parseUsage({ usage: { ...payload.usage, weekly: { percent: 5 } } }))
throws("invalid reset date", () => parseUsage({ usage: { ...payload.usage, weekly: { percent: 5, resetsAt: "not-a-date" } } }))

console.log("derived values")

check("remaining percentage", remaining(42) === 58)
check("nothing used", remaining(0) === 100)
check("everything used", remaining(100) === 0)
check("remaining clamps above 100", remaining(-5) === 100)
check("remaining clamps below 0", remaining(120) === 0)
check("integer percent formatting", formatPercent(93) === "93%")
check("decimal percent formatting", formatPercent(92.5) === "92.5%")
check("invalid percent formatting", formatPercent(Number.NaN) === "?")

const now = Date.parse("2026-10-23T08:00:00.000Z")
check("hours and minutes countdown", formatCountdown("2026-10-23T12:12:00.000Z", now) === "4h 12m")
check("days and hours countdown", formatCountdown("2026-10-26T00:00:00.000Z", now) === "2d 16h")
check("minutes countdown", formatCountdown("2026-10-23T08:04:00.000Z", now) === "4m")
check("sub-minute countdown", formatCountdown("2026-10-23T08:00:20.000Z", now) === "<1m")
check("past reset", formatCountdown("2026-10-23T07:00:00.000Z", now) === "now")
check("invalid reset", formatCountdown("nope", now) === "")

const isoReset = "2026-10-26T00:00:00.000Z"
const utcReset = formatResetAt(isoReset, { locale: "en-US", timeZone: "UTC" })
const localReset = formatResetAt(isoReset, { locale: "en-US", timeZone: "America/New_York" })
check("reset rendered in UTC", utcReset.includes("Oct") && utcReset.includes("12:00"), utcReset)
check("reset rendered in another time zone", localReset !== utcReset && localReset.includes("25"), localReset)
check("invalid reset representation", formatResetAt("nope") === "")

check("just now", formatAgo(now - 2_000, now) === "just now")
check("seconds ago", formatAgo(now - 4_000, now) === "4s ago")
check("minutes ago", formatAgo(now - 180_000, now) === "3m ago")
check("hours ago", formatAgo(now - 2 * 3_600_000, now) === "2h ago")
check("days ago", formatAgo(now - 3 * 86_400_000, now) === "3d ago")

console.log("api key selection")

const goKey = (active, key) => ({ integrationID: "opencode-go", active, value: { type: "key", key } })
const env = { CUSTOM_GO_KEY: "  env-key  " }

const fromEnv = selectApiKey({ envName: "CUSTOM_GO_KEY", env, credentials: [goKey(true, "credential-key")] })
check("environment wins and is trimmed", fromEnv.key === "env-key" && fromEnv.source === "env", JSON.stringify(fromEnv))

const activeKey = selectApiKey({ envName: "CUSTOM_GO_KEY", env: {}, credentials: [goKey(false, "old"), goKey(true, "active")] })
check("active credential used", activeKey.key === "active" && activeKey.source === "credential", JSON.stringify(activeKey))

const fallbackKey = selectApiKey({ envName: "X", env: {}, credentials: [goKey(false, "only")] })
check("inactive credential fallback", fallbackKey.key === "only", JSON.stringify(fallbackKey))

const ignoresOAuth = selectApiKey({
  envName: "X",
  env: {},
  credentials: [
    { integrationID: "opencode-go", active: true, value: { type: "oauth", access: "secret" } },
    { integrationID: "github-copilot", active: true, value: { type: "key", key: "wrong" } },
  ],
})
check("ignores oauth and other integrations", ignoresOAuth.key === undefined, JSON.stringify(ignoresOAuth))

check("no key found", Object.keys(selectApiKey({ envName: "X", env: {}, credentials: [] })).length === 0)

console.log("fetch")

function fakeResponse(status, body, jsonError) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (jsonError) throw new Error("bad json")
      return body
    },
  }
}

async function rejects(name, run, predicate) {
  try {
    await run()
    check(name, false, "did not throw")
  } catch (error) {
    check(name, predicate(error), String(error))
  }
}

let captured
const fetched = await fetchUsage("test-key", {
  fetch: async (url, init) => {
    captured = { url, init }
    return fakeResponse(200, payload)
  },
})
check("usage URL", captured.url === "https://opencode.ai/zen/go/v1/usage", captured.url)
check("bearer authorization", captured.init.headers.Authorization === "Bearer test-key")
check("request user agent", captured.init.headers["User-Agent"] === "opencode-go-panel/1.0")
check("parsed fetch result", fetched.weekly.percent === 5, JSON.stringify(fetched))

await rejects(
  "401 rejected",
  () => fetchUsage("k", { fetch: async () => fakeResponse(401, {}) }),
  (error) => error instanceof UsageError && error.status === 401,
)
await rejects(
  "429 rejected",
  () => fetchUsage("k", { fetch: async () => fakeResponse(429, {}) }),
  (error) => error instanceof UsageError && error.status === 429,
)
await rejects(
  "500 rejected",
  () => fetchUsage("k", { fetch: async () => fakeResponse(500, {}) }),
  (error) => error instanceof UsageError && error.status === 500,
)
await rejects(
  "invalid json",
  () => fetchUsage("k", { fetch: async () => fakeResponse(200, null, true) }),
  (error) => error instanceof UsageError && error.kind === "invalid",
)
await rejects(
  "timeout",
  () => fetchUsage("k", { fetch: async () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })) }),
  (error) => error instanceof UsageError && error.kind === "timeout",
)
await rejects(
  "network error",
  () => fetchUsage("k", { fetch: async () => Promise.reject(new TypeError("offline")) }),
  (error) => error instanceof UsageError && error.kind === "network",
)

check("401 message", describeError(new UsageError("x", "http", 401)) === "API key rejected")
check("403 message", describeError(new UsageError("x", "http", 403)) === "Access denied by the Go API")
check("429 message", describeError(new UsageError("x", "http", 429)) === "Rate limited by the Go API")
check("500 message", describeError(new UsageError("x", "http", 500)) === "Go API unavailable")
check("other HTTP message", describeError(new UsageError("x", "http", 418)) === "Go API error (HTTP 418)")
check("invalid response message", describeError(new UsageError("x", "invalid")) === "Unexpected usage response")
check("timeout message", describeError(new UsageError("x", "timeout")) === "Request timed out")
check("network message", describeError(new UsageError("x", "network")) === "Network error")
check("unknown error message", describeError(new Error("x")) === "Unexpected error")

console.log("panel state")

const success = settle({ stale: false }, { ok: true, usage: parsed }, 1_000)
check("success stores data and time", success.usage === parsed && success.fetchedAt === 1_000 && !success.stale)

const failure = settle(success, { ok: false, error: "Network error" }, 2_000)
check(
  "failure keeps the last data",
  failure.usage === parsed && failure.fetchedAt === 1_000 && failure.stale && failure.error === "Network error",
  JSON.stringify(failure),
)

const empty = settle({ stale: false }, { ok: false, error: "Network error" }, 2_000)
check("failure without data keeps no usage", empty.usage === undefined && empty.stale)

const recovered = settle(failure, { ok: true, usage: parsed }, 3_000)
check("success clears the stale flag", !recovered.stale && recovered.error === undefined && recovered.fetchedAt === 3_000)

console.log("debounce")

let calls = 0
const debounced = createDebouncer(20, () => {
  calls += 1
})
debounced.schedule()
debounced.schedule()
debounced.schedule()
await new Promise((resolve) => setTimeout(resolve, 60))
check("burst collapses into one call", calls === 1, String(calls))

debounced.schedule()
debounced.cancel()
await new Promise((resolve) => setTimeout(resolve, 40))
check("cancel prevents the call", calls === 1, String(calls))

if (failures > 0) {
  console.log(`\n${failures} failed`)
  process.exit(1)
}
console.log("\nsmoke ok")
