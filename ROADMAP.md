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

**ACP note:** `runWithRecovery` works for Claude Code only. Copilot (ACP
mode) surfaces stale sessions as `ErrorEvent { code: 'cli_error' }` (via
JSON-RPC error response on stdout, not stderr). ACP-aware recovery needs
to inspect `ErrorEvent.detail` for the error discriminator.

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

### DoneEvent result data (2026-07-08) ✓

**Why:** `DoneEvent` collapsed the CLIs' final-turn payload down to just
`{sessionId, usage}`, dropping data both CLIs actually report — code-wrapper
issue #20, finding #8, and the equivalent v1.0 migration-audit finding above.
Claude's raw `result` event carries `.result` (the agent's own final
summary/answer text — distinct from the streamed `assistant` text blocks),
`.is_error`, `.duration_ms`, `.total_cost_usd`, and `.num_turns`. Copilot's
ACP `session/prompt` ack carries `.stopReason` (e.g. `'end_turn'`).

**Change:** Added optional, additive fields to `DoneEvent`: `resultText`,
`isError`, `durationMs`, `totalCostUsd`, `numTurns` (Claude-only, populated
in `parseCliLine`'s `result` branch) and `stopReason` (Copilot-only,
populated in `createCopilotAcpParser`'s `session/prompt`-ack branch).
Nothing existing was removed or renamed. Copilot has no equivalent to
`resultText` — its final answer is already fully covered by the streamed
`agent_message_chunk` `TextEvent`s, so that field is intentionally left
unset rather than populated from something that isn't actually there.
Verified against both real CLIs (not just fixtures): Claude returned
`resultText: "hello"`, `isError: false`, `durationMs`, `totalCostUsd`,
`numTurns: 1`; Copilot returned `stopReason: "end_turn"`.

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

**Status:** 104 unit tests passing as of PR #11 (2026-07-08), plus live
integration tests against real `claude` and `copilot` CLI invocations
(`vitest.config.live.ts`) — Claude 5/5, Copilot 5/5.

---

## v0.4 — GitHub Copilot backend ✓

**Implemented and live-validated.** The Copilot backend uses the **Agent
Client Protocol (ACP)** — `copilot --acp --stdio` — which reached GA on
February 25, 2026.

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
  across lines, fires `ReadyEvent` at most once per session) mapping ACP
  NDJSON to normalized `ClaudeEvent`s:
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
  `stall`, `ignore-sigterm`, `nonzero-exit`, `permission-request`
- Tests (13+ total) — `ready`/`done` events with session ID, AbortSignal
  mid-run, max timeout, permission/request → RawEvent, idle timeout,
  SIGKILL escalation, nonzero exit

### Real-CLI hardening (PR #11, 2026-07-08)

Live testing against the actual `copilot` binary (v1.0.68) surfaced and
fixed protocol bugs that unit tests against a hand-rolled fake fixture
could not catch:

- `protocolVersion` must be an integer, not the string `'2025-01'`
- `session/new` requires `mcpServers: []`
- stdin must stay open until a `DoneEvent` or process `exit` — closing it
  immediately after `session/prompt` killed the CLI before it could
  stream text (fixed via a `proc.on('exit', ...)` handler to avoid a
  stdin/close deadlock)
- Resume does **not** reuse the original session UUID — the real
  protocol is a fresh `initialize` → `session/new` → `session/prompt`
  sequence with `--resume=<uuid>` supplying context; `session/new`
  returns a **new** UUID for the resumed session
- Real streaming text arrives as `agent_message_chunk` with
  `params.update.content.text`, not the notification shapes the fake
  fixture originally assumed

Auth for headless/CI use requires a **user-owned fine-grained PAT with
the "Copilot Requests" permission** — classic PATs (`ghp_`) are
explicitly rejected by the CLI. See `docs/copilot-auth.md` (or the PR
#11 description) for the full auth investigation.

### ACP error handling note

ACP stale-session and rate-limit conditions arrive as JSON-RPC error
responses on stdout, not stderr. They surface as `ErrorEvent { code:
'cli_error' }`. The stderr-based `STALE_SESSION_RE` / `RATE_LIMIT_RE`
checks and `runWithRecovery()` do not apply to ACP mode.

### ACP reference

- Protocol: `copilot --acp --stdio`, NDJSON JSON-RPC over stdin/stdout
- SDK: `@github/copilot-sdk` (Node.js, GA June 2, 2026) wraps ACP with
  typed events (`assistant.message_delta`, `session.idle`, etc.)
- Research report:
  `03 - Research Topics/2026-06-20 GitHub Copilot CLI Machine-Parseable Output/`

---

## v1.0 — Production release

**Redefined 2026-07-08.** The original criterion — "replace the bespoke
Claude/Copilot invocation code in documentation_robotics, codetoreum,
phone-home, and rounds" — was written when this roadmap believed
codetoreum would be "Switchyard's Node.js successor, once scaffolded."
That assumption is factually wrong: codetoreum is a fully-scaffolded,
actively-developed **Python/FastAPI** hexagonal system with its own
2,395-LOC `ClaudeCodeAdapter`. Of the four original targets, exactly
**one is Node.js**: documentation_robotics. The other three
(codetoreum, phone-home, rounds) are Python and cannot depend on this
package directly.

Two rounds of architecture review (see `docs/v1-scope-decision.md` if
present, or PR discussion) considered and rejected bridging the language
gap for v1.0 — see "De-scoped: the three Python projects" below. v1.0 is
now scoped to what's actually achievable:

- [ ] Published to npm as `@tinkermonkey/code-wrapper`
- [ ] `CHANGELOG.md` with semver entries from v0.1 onward
- [ ] `README.md` with quick-start, all `ProcessOptions` documented,
  event type table, and session management guide
- [ ] Bun runtime compatibility smoke-tested (`CliProcess` under
  `Bun.spawn`'s `node:child_process` compat layer) — documentation_robotics'
  WebSocket server runs under Bun; this is unvalidated
- [ ] documentation_robotics fully migrated off its three duplicated
  Claude implementations and its plain-text Copilot client — see
  migration checklist below

### documentation_robotics migration — capability-parity audit findings

A line-by-line capability-parity audit (2026-07-08, comparing the actual
source of both projects, not just capability summaries) found the
migration is a **net upgrade, not a pure upgrade** — four items need
explicit engineering attention, not just a library swap:

- [ ] **Copilot `explain` one-shot path has no ACP equivalent.**
  `server.ts:2318-2347` has a third Copilot invocation path (`gh copilot
  explain` / `copilot explain`) separate from `copilot-client.ts`, with
  no session/resume flag at all. code-wrapper's Copilot backend only
  implements ACP. Confirm whether this path is actually reachable/used
  before assuming parity; if it is, it needs either an ACP-based
  replacement or an explicit decision to drop it.
- [ ] **`--dangerously-skip-permissions` → `--permission-mode
  bypassPermissions` needs a live smoke test.** Both flags exist on the
  CLI and are very likely equivalent, but this is a flag substitution,
  not a renamed alias — verify behaviorally, not just by reading
  `--help` text, against the exact `claude` CLI version(s)
  documentation_robotics targets.
- [ ] **Session-ID pre-assignment is a migration footgun.**
  documentation_robotics generates a session UUID *before* the first
  message, shows it in the chat banner, and embeds it in the log
  filename (`chat-logger.ts`). code-wrapper's `SessionManager` idiom
  (per its own README) leaves the CLI session ID undefined until a
  `done` event arrives on turn 1. `ProcessOptions.sessionId` DOES accept
  a caller-supplied ID structurally — migration code must explicitly
  thread its own UUID through rather than following the default
  `SessionManager` pattern, or the "session ID shown before first
  message" UX breaks.
- [ ] **Timeout defaults will kill currently-unbounded calls.**
  code-wrapper defaults to `idleTimeout: 300` / `maxTimeout: 3600`
  (seconds). Two of the three current documentation_robotics
  implementations impose no timeout at all — a long-running audit or
  chat call would previously run indefinitely. Both the interactive
  chat path and `audit/ai/runner.ts`'s audit path need explicit
  `ProcessOptions` timeout overrides set before/during migration, not
  left at the library default.
- [x] **Verify the WebSocket frontend's use of `chat.tool.result`.**
  `server.ts` currently forwards the raw `result` event's final-text
  field to the browser via a `chat.tool.result` WS message.
  ~~code-wrapper's `DoneEvent` only carries `sessionId` + usage stats —
  no equivalent text field.~~ **Resolved** (code-wrapper issue #20,
  finding #8): `DoneEvent` now additionally carries `resultText`,
  `isError`, `durationMs`, `totalCostUsd`, `numTurns` (from Claude's
  `result` event) and `stopReason` (from Copilot's ACP `session/prompt`
  ack) — see "DoneEvent result data" note under v0.2 below. The
  migration's WebSocket forwarding can now read `resultText` directly
  instead of accumulating `TextEvent`s client-side.

Everything else audited (event/data coverage, non-JSON-line handling,
ambient `claude login` auth passthrough, most CLI flags, Copilot
`--continue`-vs-`--resume=<uuid>` session semantics, `Bun.spawn` option
usage) came back **PARITY or GAIN** — no other losses found. The
migration itself should proceed in three ordered PRs: delete the dead
`agents/claude-code.ts` (238 LOC, unused), replace `claude-code-client.ts`
(the `dr chat` path), then replace the `server.ts` inline WebSocket path
(currently has *no* session support at all — this is the biggest
capability gain of the whole migration, not just deduplication).

### De-scoped: the three Python projects

**phone-home:** its `shared/claude_session.py` (816 LOC) is already a
single, well-factored driver serving three consumer types (control
plane, generic agent nodes, specialist nodes), with working session
persistence, stale-session auto-recovery, and battle-tested SIGTERM→
SIGKILL teardown (added after a real orphaned-process production
incident). Replacing it through any Node bridge would be a lateral move
purchased with the fleet's most reliability-sensitive component, to gain
Copilot support it has zero demand for. Not planned.

**codetoreum:** wrong language (Python/FastAPI) and a diverging Copilot
strategy — its planned Copilot integration is a pure HTTP client against
GitHub's hosted Copilot Cloud Agent API, architecturally unrelated to
local ACP. Its hexagonal port/adapter structure (`ICodingAgent`) means a
future implementation swap is cheap if this ever changes. Not planned.

**rounds:** wrong language and wrong interaction model — single-shot
`claude -p ... --output-format json` envelope calls (local subprocess
and SSH-remote-to-agent-node), no streaming, no sessions, no Copilot.
Its one real deficiency (no graceful SIGTERM-before-SIGKILL phase on
timeout) is a ~20-line local fix, not a reason to adopt a cross-language
bridge. Not planned.

If a Python project's needs change:
- For "stop hand-rolling Claude's stream-json protocol in Python," the
  first candidate is Anthropic's official **Claude Agent SDK for
  Python** (`claude-agent-sdk`) — verify current feature parity, but it
  will always beat a bridge to this package on simplicity for anything
  Claude-only.
- For **local Copilot ACP** specifically, no Python-native equivalent
  exists — this package's hard-won ACP implementation (see the v0.4
  real-CLI-hardening notes above) is the only place that protocol
  knowledge lives. That's the trigger for revisiting a bridge — see v2
  below.

---

## v2 (future, trigger-gated) — `code-wrapper exec`

**Not being built now.** Recorded here so the design isn't re-litigated
from scratch if the trigger fires.

**Design:** a *thick*, compiled CLI (`bun build --compile` or Node SEA)
built on code-wrapper's own internals — it performs session management,
event parsing, resume/stale-session recovery, and retry logic itself,
and exposes only a structured output contract (NDJSON events per line,
or a single JSON envelope on completion) to whatever spawns it. A Python
(or any other language) caller's job shrinks to: spawn the process, read
stdout, parse JSON — not hand-roll the wire protocol.

**Why not a thin shim:** a thin passthrough (same output format,
different binary name) just retargets the existing bespoke parsing code
without shrinking it — rejected in the first architecture review.

**Why not now, given the thick design is real:** its two value
propositions — centralized session/resume management and Copilot ACP —
are wanted by zero of the de-scoped Python projects today. phone-home
already has working session management; codetoreum and rounds are both
single-shot with no session concept; no Python project has Copilot
demand. Building it now means paying a second-product-surface tax
(versioned NDJSON wire contract, contract tests, fleet version pinning,
double-hop process supervision — the CLI's own `claude` child can orphan
if the CLI process is hard-killed, unless it implements its own
process-group management) for consumers who would adopt it as a
lateral-or-worse move.

**Explicit trigger:** build this the first time either becomes true:
1. A Python project needs **local Copilot ACP** (not the hosted HTTP
   Cloud Agent API codetoreum is planning).
2. A Python project needs **one contract over both Claude and Copilot**
   backends (the terraform-provider-normalization pattern — only
   valuable when a consumer actually wants multiple backends).

**Cheap prep to do now, regardless of trigger timing:**
- Document the `ClaudeEvent` union as a versioned schema (already TS
  types — nearly free, and doubles as library documentation).
- Fold process-group/child-cleanup behavior into the Bun compatibility
  validation documentation_robotics' migration already needs — the ACP
  stdin-timing bug (see v0.4 notes) is a standing reminder that
  process/stdio lifecycle behavior is where this project's bugs
  concentrate.

**Distribution, if built:** the existing Ansible-managed fleet makes
"distribute a compiled binary to N hosts, pin its version" a single
role — solves the cross-host Node-runtime-dependency problem that would
otherwise block `rounds`' SSH-remote-invocation pattern.

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
