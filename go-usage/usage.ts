const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const USER_AGENT = "opencode-go-panel/1.0"
const TIMEOUT = 5000

export type WindowName = "rolling" | "weekly" | "monthly"

export type UsageWindow = {
  percent: number
  resetsAt: string
  status?: string
}

export type GoUsage = Record<WindowName, UsageWindow>

export type UsageErrorKind = "http" | "network" | "timeout" | "invalid"

export class UsageError extends Error {
  readonly kind: UsageErrorKind
  readonly status?: number

  constructor(message: string, kind: UsageErrorKind, status?: number) {
    super(message)
    this.name = "UsageError"
    this.kind = kind
    this.status = status
  }
}

export type PanelState = {
  usage?: GoUsage
  fetchedAt?: number
  stale: boolean
  error?: string
}

export type Outcome = { ok: true; usage: GoUsage } | { ok: false; error: string }

export type CredentialLike = {
  integrationID: string
  active?: boolean
  value: { type: string; key?: string; access?: string }
}

export type KeyInput = {
  envName: string
  env?: Record<string, string | undefined> | ((name: string) => string | undefined)
  credentials?: readonly CredentialLike[]
}

export type KeyResult = {
  key?: string
  source?: "env" | "credential"
}

function window(value: unknown, name: WindowName): UsageWindow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`Missing ${name} window`, "invalid")
  }

  const record = value as Record<string, unknown>
  const percent = record.percent
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new UsageError(`Invalid ${name} percent`, "invalid")
  }

  const resetsAt = record.resetsAt
  if (typeof resetsAt !== "string" || !resetsAt.trim() || !Number.isFinite(Date.parse(resetsAt))) {
    throw new UsageError(`Invalid ${name} reset date`, "invalid")
  }

  const status = typeof record.status === "string" && record.status ? record.status : undefined
  return { percent, resetsAt, ...(status ? { status } : {}) }
}

// Accepts the `{ "usage": { rolling, weekly, monthly } }` payload and rejects
// anything the panel would have to guess about.
export function parseUsage(value: unknown): GoUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError("Missing usage payload", "invalid")
  }

  const usage = (value as { usage?: unknown }).usage
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new UsageError("Missing usage payload", "invalid")
  }

  const record = usage as Record<string, unknown>
  return {
    rolling: window(record.rolling, "rolling"),
    weekly: window(record.weekly, "weekly"),
    monthly: window(record.monthly, "monthly"),
  }
}

export function remaining(percent: number): number {
  return Math.min(100, Math.max(0, 100 - percent))
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "?"
  const rounded = Math.round(value)
  return Math.abs(value - rounded) < 0.05 ? `${rounded}%` : `${value.toFixed(1)}%`
}

export function formatCountdown(resetsAt: string, now = Date.now()): string {
  const time = Date.parse(resetsAt)
  if (!Number.isFinite(time)) return ""
  const delta = Math.max(0, Math.floor((time - now) / 1000))
  if (delta <= 0) return "now"
  const days = Math.floor(delta / 86400)
  const hours = Math.floor((delta % 86400) / 3600)
  const minutes = Math.floor((delta % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return "<1m"
}

export function formatResetAt(
  resetsAt: string,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const time = Date.parse(resetsAt)
  if (!Number.isFinite(time)) return ""
  return new Intl.DateTimeFormat(options.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: options.timeZone,
  }).format(new Date(time))
}

export function formatAgo(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp)) return ""
  const delta = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (delta <= 2) return "just now"
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

// Environment wins over the credential store so a key can be overridden for
// testing without signing in. An OpenCode Go key credential is preferred (the
// active one, then the first stored key), and the OpenCode Console OAuth access
// token is used as a fallback so users who signed in through the Console do not
// need a separate Go key.
export function selectApiKey(input: KeyInput): KeyResult {
  const source = input.env
  const read = typeof source === "function" ? source : (name: string) => source?.[name]
  const fromEnv = read(input.envName)?.trim()
  if (fromEnv) return { key: fromEnv, source: "env" }

  const keys = (input.credentials ?? []).filter(
    (entry) =>
      entry.integrationID === "opencode-go" &&
      entry.value?.type === "key" &&
      typeof entry.value.key === "string" &&
      entry.value.key.trim().length > 0,
  )

  const entry = keys.find((candidate) => candidate.active) ?? keys[0]
  const key = entry?.value.key?.trim()
  if (key) return { key, source: "credential" }

  const oauth = (input.credentials ?? []).find(
    (entry) =>
      entry.integrationID === "opencode" &&
      entry.active !== false &&
      entry.value?.type === "oauth" &&
      typeof entry.value.access === "string" &&
      entry.value.access.trim().length > 0,
  )

  const access = oauth?.value.access?.trim()
  return access ? { key: access, source: "credential" } : {}
}

export function settle(previous: PanelState, outcome: Outcome, now = Date.now()): PanelState {
  if (outcome.ok) return { usage: outcome.usage, fetchedAt: now, stale: false }
  return {
    usage: previous.usage,
    fetchedAt: previous.fetchedAt,
    stale: true,
    error: outcome.error,
  }
}

export function describeError(error: unknown): string {
  if (error instanceof UsageError) {
    if (error.kind === "timeout") return "Request timed out"
    if (error.kind === "network") return "Network error"
    if (error.status === 401) return "API key rejected"
    if (error.status === 403) return "Access denied by the Go API"
    if (error.status === 429) return "Rate limited by the Go API"
    if (error.status !== undefined && error.status >= 500) return "Go API unavailable"
    if (error.kind === "http") return `Go API error (HTTP ${error.status ?? "?"})`
    return "Unexpected usage response"
  }
  return "Unexpected error"
}

export function createDebouncer(delay: number, run: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        run()
      }, delay)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

export type FetchUsageOptions = {
  fetch?: typeof globalThis.fetch
  timeout?: number
}

function aborted(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError")
}

export async function fetchUsage(apiKey: string, options: FetchUsageOptions = {}): Promise<GoUsage> {
  if (!apiKey) throw new UsageError("Missing API key", "invalid")

  const request = options.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeout ?? TIMEOUT)

  let response: Response
  try {
    response = await request(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    })
  } catch (error) {
    throw aborted(error)
      ? new UsageError("Request timed out", "timeout")
      : new UsageError("Network error", "network")
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) throw new UsageError(`Go usage API: HTTP ${response.status}`, "http", response.status)

  let json: unknown
  try {
    json = await response.json()
  } catch {
    throw new UsageError("Invalid JSON response", "invalid")
  }

  return parseUsage(json)
}
