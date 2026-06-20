# code-wrapper — Roadmap

This roadmap tracks the work required to reach full parity with the two
systems that inspired this module: **Switchyard** (Python CI/CD
orchestrator) and the **Documentation Robotics CLI** (Node.js/Hono agent
server). It also tracks the **GitHub Copilot backend**, which is the
other significant consumer capability not yet implemented.

---

## Current state (v0.1)

The foundation is complete and production-hardened:

- [x] `CliProcess` — subprocess spawn, stdin delivery, SIGTERM → 3s → SIGKILL
- [x] `EventParser` — all known raw event types mapped; `RawEvent` zero-loss fallback
- [x] Shared async queue — watchdog `ProgressEvent` interleaves with stdout lines
- [x] `SessionManager` + `FileStore` — atomic writes, namespace isolation
- [x] `system/init` → `ReadyEvent` (session ID, model, tool names)
- [x] `system/api_retry` → `RetryEvent`
- [x] `assistant/thinking` → `ThinkingEvent`
- [x] `tool_result` (direct) → `ToolResultEvent`
- [x] `result` → `DoneEvent` with all four usage fields (incl. cache tokens)
- [x] `rate_limit_event` → `ErrorEvent { code: 'rate_limit' }`
- [x] `error`/`error_detail`/`error_event` → `ErrorEvent { code: 'cli_error' }`
- [x] Spawn error (`ENOENT`, `EACCES`) → `ErrorEvent { code: 'spawn_error' }`
- [x] Stale session detection from stderr
- [x] Nonzero exit → `ErrorEvent { code: 'nonzero_exit', exitCode }`
- [x] `CLAUDECODE` env deletion (prevents nested session refusal)
- [x] `--permission-mode bypassPermissions` support
- [x] `--agent`, `--mcp-config`, `--session-id` / `--resume` flags
- [x] `listSessions()` namespace isolation
- [x] `flush()` propagates write errors to callers

---

## v0.2 — Completeness

Small gaps against the already-implemented design that were noted during
the code review but are not bugs.

### Immediate ProgressEvent at spawn

**Why:** The first watchdog tick fires 5 seconds after spawn. Callers
that want an elapsed=0 heartbeat on connection have no signal until then.
Switchyard emits a synthetic `task_started` event immediately on spawn;
DR CLI's `BaseChatClient` fires a `started` lifecycle hook.

**Change:** Push a `ProgressEvent { elapsed: 0 }` into the queue
immediately after `proc` is created, before the readline and watchdog
are wired.

### `AbortSignal` on `ProcessOptions`

**Why:** DR CLI exposes HTTP endpoints; a disconnecting HTTP client should
be able to cancel the in-flight agent. Without `AbortSignal` support the
caller's only escape is `CliProcess.kill()`, which requires holding the
`CliProcess` instance across the request boundary. An `AbortSignal` makes
cancellation composable with `fetch`, `Request`, and `AsyncContext`.

**Change:** Add `signal?: AbortSignal` to `ProcessOptions`. In `run()`,
add `signal.addEventListener('abort', ...)` that calls `proc.kill()`;
the generator then surfaces an `ErrorEvent { code: 'aborted' }`. Remove
the listener in `finally`.

**New `ErrorCode`:** Add `'aborted'` to the union.

### Export `runWithRecovery` as a utility

**Why:** The stale-session recovery pattern appears in the architecture
doc as pseudocode and will be reimplemented identically by every caller.
Exporting it reduces boilerplate and keeps recovery semantics consistent.

**Change:** Implement and export `runWithRecovery(proc, sessions, key,
opts)` as an async generator in `src/process/recovery.ts`. Add it to the
`./process` barrel and the top-level `src/index.ts`.

**Signature:**
```typescript
async function* runWithRecovery(
  proc: CliProcess,
  sessions: SessionManager,
  key: string,
  opts: ProcessOptions,
): AsyncGenerator<ClaudeEvent>
```

On `stale_session`: calls `sessions.clearSession(key)` and retries once
with `sessionId: undefined, isFirstMessage: true`. Does not retry a
second stale_session error.

### `user` turn ToolResultEvent extraction

**Why:** Currently `user` turn events are captured as `RawEvent`.
When `--verbose` is active the CLI also emits top-level `tool_result`
events, so tool results are never actually lost. However if a caller
runs without `--verbose`, or if the CLI's behavior changes, tool results
would only appear inside `RawEvent.data.message.content`.

**Change:** In `EventParser`, when `raw.type === 'user'` and
`raw.message?.content` contains blocks of `type: 'tool_result'`, extract
them as `ToolResultEvent` entries **in addition to** the `RawEvent`.
Preserve the `RawEvent` so the full user turn is still available.

**Priority:** Low — `--verbose` is always passed by `CliProcess`.

---

## v0.3 — Test suite

Neither Switchyard nor DR CLI has a shared test harness for the CLI
interaction layer. This is the largest DX gap relative to a
production-grade module.

### EventParser unit tests

Covers every branch in `parseCliLine`:

- `system/init` with full fields, partial fields, empty tools
- `system/api_retry`
- `system/<unknown subtype>` → `RawEvent`
- `assistant` with text, thinking, tool_use blocks
- `assistant` with mixed block types
- `assistant` with empty content array → `RawEvent`
- `assistant` with unknown block type → `RawEvent`
- `tool_result` direct
- `user` → `RawEvent`
- `result` with full usage, partial usage, no usage
- `rate_limit_event` with `reset_at`, with `retry_after`, bare
- `error`, `error_detail`, `error_event`
- Unknown top-level type → `RawEvent`
- Malformed JSON (starts with `{`) → `ErrorEvent { parse_error }`
- Plaintext line → `TextEvent`
- `seq` increments correctly across multi-event lines

### SessionManager unit tests

- `newSession` / `resumeSession` round-trip
- `recordCliSessionId` sets `cliSessionId` and `isFirst = false`
- `clearSession` removes entry
- `listSessions` returns only sessions matching the namespace prefix
- `listSessions` with `namespace: ''` returns all sessions
- `listSessions` sorted by `lastActiveAt` descending
- `FileStore` atomic write (tmp + rename)
- `FileStore.flush()` propagates write errors
- `FileStore.load()` starts empty on missing file
- `MemoryStore` correct behavior across all four methods

### Integration test harness

A helper that spawns a minimal fake `claude` binary (a Node.js script)
that writes scripted stream-json lines to stdout and exits with a
configured code. Lets `CliProcess.run()` be tested end-to-end without
the real CLI binary present.

Covers:
- Full golden-path run (init → text → tool_use → tool_result → result)
- Idle timeout (fake binary that stalls)
- Max timeout
- Nonzero exit
- SIGTERM handling (fake binary that exits on SIGTERM)
- SIGKILL escalation (fake binary that ignores SIGTERM)
- Spawn failure (binary path that does not exist)
- Stale session error in stderr

### Recommended framework

`vitest` — fast, native ESM, no extra transpile config needed for a
`"type": "module"` package. Add `"test": "vitest run"` to `package.json`.

---

## v0.4 — GitHub Copilot backend ✓

**Implemented.** The Copilot backend uses the **Agent Client Protocol
(ACP)** — `copilot --acp --stdio` — which reached GA on February 25,
2026.

Plain-text parsing (`copilot --prompt <msg>`) was explicitly ruled out:
GitHub built ACP as the designated machine-parseable interface, and the
previous undocumented interface (`--headless --stdio`) was removed without
deprecation warning (copilot-cli issue #1606), breaking all downstream
wrappers. ACP is its stable replacement.

### What was built

- `buildCopilotArgs()` — returns `['--acp', '--stdio']` plus optional
  `--allow-all-tools`, `--agent`, `--resume=<uuid>`
- ACP handshake in `run()` — writes `initialize` → `session/new` →
  `session/prompt` NDJSON messages to stdin then closes; prompt is a
  `session/prompt` params field, not a CLI flag
- `createCopilotAcpParser()` — stateful factory (tracks `sessionUuid`
  across lines) mapping ACP NDJSON to normalized `ClaudeEvent`s:
  - `session/new` response (`result.sessionId`) → `ReadyEvent { sessionId }`
  - `session/update` (type `assistant.message_delta`) → `TextEvent`
  - `assistant.message_delta` notification → `TextEvent`
  - `assistant.message` notification → `TextEvent`
  - `session.idle` notification → `DoneEvent { sessionId }`
  - `permission/request` notification → `RawEvent`
  - ACP error response (`msg.error`) → `ErrorEvent { code: 'cli_error' }`
  - All other responses → `RawEvent` (zero-loss)
- `fake-copilot.mjs` — test binary speaking full NDJSON JSON-RPC; handles
  `initialize`, `session/new`, `session/prompt`; scenarios: `golden-path`,
  `stall`, `ignore-sigterm`, `nonzero-exit`
- Tests — copilot golden path now verifies `ready` and `done` events (with
  `sessionId: 'copilot-sess-abc123'`) in addition to `progress` and `text`

### ACP reference

- Protocol: `copilot --acp --stdio`, NDJSON JSON-RPC over stdin/stdout
- SDK: `@github/copilot-sdk` (Node.js, GA June 2, 2026) wraps ACP with
  typed events (`assistant.message_delta`, `session.idle`, etc.)
- Research report:
  `03 - Research Topics/2026-06-20 GitHub Copilot CLI Machine-Parseable Output/`

---

## v0.5 — Switchyard parity (Codetoreum migration)

Switchyard is Python and cannot import this Node.js module directly. The
primary migration path is Codetoreum, Switchyard's Node.js successor.
This milestone prepares the module to be a first-class dependency of
that migration.

### Codetoreum integration checklist

- [ ] Confirm `@tinkermonkey/code-wrapper` is listed in Codetoreum's
  `package.json` once Codetoreum is scaffolded
- [ ] Map Switchyard's `ObservabilityEvent` lifecycle types to
  `ClaudeEvent` equivalents (document gaps in `ARCHITECTURE.md`)
- [ ] Confirm `RawEvent` covers all Switchyard event types that have no
  direct mapping
- [ ] Add `task_id` / `pipeline_run_id` passthrough support if
  Codetoreum needs them in `BaseEvent` — or document that callers add
  metadata fields via a wrapper
- [ ] Redis sink adapter — lives in Codetoreum, not here, but needs the
  `seq` field to be reliable for XADD ordering (already is)

### Switchyard patterns already covered

| Switchyard pattern | code-wrapper equivalent |
|----|----||
| `subprocess.Popen` + line-by-line read | `CliProcess` + readline |
| `system/init` session capture | `ReadyEvent` |
| `--resume <session_id>` | `ProcessOptions.sessionId + isFirstMessage: false` |
| Two-phase cleanup (wait → kill) | SIGTERM → 3s → SIGKILL |
| All raw CLI event types | `EventParser` (zero-loss) |
| `result` + `usage.*` | `DoneEvent.usage` |

---

## v1.0 — Production release

Gating criteria for a stable public API:

- [ ] v0.2, v0.3, v0.4 milestones complete
- [ ] Copilot backend tested against a real `copilot --acp --stdio` invocation
- [ ] DR CLI integrated and using `@tinkermonkey/code-wrapper` instead
  of its own subprocess layer
- [ ] Codetoreum using `@tinkermonkey/code-wrapper` (or a
  migration-readiness review completed)
- [ ] `CHANGELOG.md` with semver entries from v0.1 onward
- [ ] Published to npm as `@tinkermonkey/code-wrapper`
- [ ] `README.md` with quick-start, all `ProcessOptions` documented,
  event type table, and session management guide

---

## Out of scope (stays in the consuming app)

These will never move into this module — they are application concerns:

| Concern | Why it stays in the app |
|----|----||
| HTTP server, SSE, WebSocket | Framework choice is the app's |
| Redis XADD / pub/sub sinks | Destination-agnostic by design |
| OpenTelemetry spans and metrics | App observability layer |
| Docker container management | Infrastructure layer |
| Circuit breaker / retry policy | App decides on backoff strategy |
| Task / pipeline metadata enrichment | App-level context |
| Rate limit queuing | App-level resource management |
| `BaseChatClient` polymorphism | DR CLI's own abstraction on top |
| `ObservabilityEvent` taxonomy | Switchyard / Codetoreum orchestration layer |
