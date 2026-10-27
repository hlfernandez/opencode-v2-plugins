# opencode-go-panel

OpenCode Go quota in the [OpenCode](https://opencode.ai) V2 CLI sidebar: the rolling
(5 h), weekly and monthly usage windows, with their reset times.

```text
▼ Go Usage
Rolling 100% left · 4h 8m (Oct 23, 12:08 PM)
Weekly   95% left · 2d 16h (Oct 26, 12:00 AM)
Monthly  96% left · 23d 4h (Nov 15, 12:59 PM)
Updated 4s ago
```

- Percentages are **remaining**, derived from the consumed percentage returned by Go
  (`100 - used`). Colour follows the remaining budget: normal, warning at 20 % or
  less, error at 5 % or less.
- Reset times show a countdown plus the absolute time in your local time zone.
- Collapse or expand the section by clicking its header; the state persists across
  restarts.
- A failed refresh keeps the last good values and marks them stale instead of
  blanking the panel.

## Requirements

- OpenCode V2 CLI (`opencode` 2.x).
- An OpenCode Go account, already signed in to OpenCode, or `OPENCODE_GO_API_KEY`
  set in the environment.
- Network access to `opencode.ai` from the machine running the CLI.

## Install

This is a **CLI-only** plugin. Add it to `cli.json`, not to `opencode.json(c)`:

```jsonc title="~/.config/opencode/cli.json"
{
  "plugins": [
    { "package": "opencode-go-panel", "options": { "interval": 60000 } }
  ]
}
```

A string entry works too and uses the defaults:

```jsonc
{ "plugins": ["opencode-go-panel"] }
```

For a local checkout, OpenCode discovers packages placed in
`<config>/plugins/<name>/` automatically.

## Authentication

The plugin resolves the token in this order:

1. The environment variable named by `apiKeyEnv` (`OPENCODE_GO_API_KEY` by default).
2. An **OpenCode Go** credential stored by OpenCode V2. The active key is preferred;
   if none is active, the first stored key is used.
3. An active **OpenCode Console** OAuth credential (`integrationID: "opencode"`). Its
   access token is sent as the bearer token, so users who signed in through the
   Console can use the panel without a separate Go key.

The plugin asks the connected OpenCode service through `credential.list()`, keeps the
token in memory for the session, and never writes it to disk, configuration, storage
or logs.

If none is found, the panel shows an orange message with the options above. Signing in
again through OpenCode updates the credential; the plugin picks it up on
`credential.updated` / `credential.switched` events and re-reads the credential after
a 401.

The Console access token can expire. The plugin does not refresh it itself; it relies
on OpenCode to refresh the stored credential and reads the new token on the next
refresh after a 401 or when a credential event arrives. A Console account without Go
entitlement may produce an API error instead of the `No OpenCode Go key found`
message.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `interval` | number (ms) | `60000` | Backstop refresh period. Values below `5000` fall back to `60000`. |
| `apiKeyEnv` | string | `OPENCODE_GO_API_KEY` | Environment variable checked before the stored credential. |
| `enabled` | boolean | `true` | Set to `false` to keep the package configured but unloaded. |

## Refresh

- Once when the plugin loads.
- When a session becomes idle (`session.idle`), debounced to 750 ms.
- When the Go or Console credential is updated or switched.
- Every `interval` milliseconds as a backstop.

Requests time out after 5 s. HTTP 401/403, 429, 5xx, timeouts and network errors are
reported in the panel; the last successful values stay visible until a refresh
succeeds.

## Data source

`GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <Go key or Console access token>`:

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 0, "resetsAt": "2026-10-23T12:08:13.000Z" },
    "weekly":  { "status": "ok", "percent": 5, "resetsAt": "2026-10-26T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 4, "resetsAt": "2026-11-15T12:59:07.000Z" }
  }
}
```

The panel trusts the Go server rather than summing tokens or costs from local
sessions. The payload is validated strictly: all three windows, numeric percentages
between 0 and 100, and parseable `resetsAt` values.

## Notes and limitations

- The endpoint is not part of OpenCode's public API documentation and may change.
- A custom `User-Agent` is required; the default of scripted HTTP clients is blocked
  by Cloudflare.
- With a remote OpenCode server, the plugin uses that server's stored Go or Console
  credential and the local CLI still performs the HTTPS request.
- No notifications or usage alerts yet; only the colour changes.
- Read-only: the plugin never modifies your account, sessions or configuration.

## Development

```sh
bun test/usage.test.mjs
# or
npm test
```

The suite covers the payload parser, remaining percentages, countdowns and local
reset times, key selection (including the Console OAuth fallback), HTTP errors, state
retention after a failed refresh, and debounce behaviour.

## License

MIT
