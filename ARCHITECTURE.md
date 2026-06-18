# code-wrapper — Architecture

This document covers the module's internal design, the key TypeScript interfaces, and a detailed mapping of what the module covers (and does not cover) for its two MVP consumers: the **Documentation Robotics CLI** and the **Switchyard** orchestrator.

---

## Module overview

The module is split into three layers, each independently importable:

```
src/
  process/          # CliProcess — subprocess lifecycle
    types.ts          ProcessOptions, CliBackend
    CliProcess.ts     spawn, watchdog, teardown
    index.ts          barrel

  events/           # EventParser — raw → normalized event stream
    types.ts          ClaudeEvent union + error codes
    EventParser.ts    parseCliLine()
    index.ts          barrel

  sessions/         # SessionManager — conversation continuity
    types.ts          Session
    SessionStore.ts   ISessionStore, MemoryStore, FileStore
    SessionManager.ts newSession / resumeSession / listSessions / …
    index.ts          barrel

  index.ts          # top-level barrel — re-exports all three
```

The layers have a one-way dependency:

```
process ──depends on──▶ events   (CliProcess.run() yields ClaudeEvent)
sessions                         (independent — no process dependency)
```

The calling application wires all three together. The module imposes no threading model, HTTP framework, or event routing.

---

## Event flow

```
 ┌─────────────────────────────────────────────────────────────┐
 │  CliProcess.run(options)                                    │
 │                                                             │
 │  spawn(claude --print --verbose --output-format stream-json)│
 │      │                                                      │
 │      ├── stdin ◄── options.prompt (write + end)            │
 │      │                                                      │
 │      ├── stdout ──▶ readline 'line' event                   │
 │      │                  │                                   │
 │      │                  ▼                                   │
 │      │           EventParser.parseCliLine(line, seq)        │
 │      │                  │                                   │
 │      │                  ▼                                   │
 │      │           push ──▶ shared async queue                │
 │      │                                                      │
 │      ├── stderr ── buffered; checked after queue drains     │
 │      │             • "No conversation found" → stale_session│
 │      │             • rate limit message → rate_limit        │
 │      │                                                      │
 │      ├── exitCode ── awaited after queue drains             │
 │      │             • non-zero (no stderr match) → nonzero_exit│
 │      │                                                      │
 │      ├── 'error' event ── spawn failures (ENOENT, EACCES)  │
 │      │             • saved locally; yielded after queue     │
 │      │             • pushes null sentinel to end the loop   │
 │      │                                                      │
 │      └── watchdog (setInterval, 5s tick)                   │
 │               • push ProgressEvent → shared async queue    │
 │               • idle timeout (stdout silence > N s)         │
 │               • max timeout (wall clock > M s)              │
 │               • SIGTERM → 3s → SIGKILL                     │
 │               • process death closes stdout                 │
 │               • readline 'close' pushes null sentinel       │
 │                                                             │
 │      shared async queue ──▶ yield ──▶ AsyncGenerator        │
 └─────────────────────────────────────────────────────────────┘
                │
                ▼
       caller iterates: for await (const event of process.run(opts))
       caller routes:   WebSocket / Redis / SSE / in-process queue
```

The shared async queue is the key architectural detail. Both readline (stdout lines → parsed events) and the watchdog (ProgressEvents) push into the same queue. The generator consumes from the queue, blocking only when it is empty. A `null` sentinel pushed by readline's `close` event (or by the `'error'` handler on spawn failure) terminates the consume loop.

---

## Key interfaces

### ProcessOptions

```typescript
type CliBackend = 'claude' | 'copilot';

interface ProcessOptions {
  cwd: string;               // working directory for the CLI
  prompt: string;            // delivered via proc.stdin.write() + .end()
  agent?: string;            // --agent <name>  (prepended before all other flags)
  skipPermissions?: boolean; // --permission-mode bypassPermissions (default false)
  mcpConfigPath?: string;    // --mcp-config <path>

  // Session continuity
  sessionId?: string;        // present when resuming; omit for a brand-new session
  isFirstMessage?: boolean;  // true  → --session-id <id>  (start traceable session)
                             // false → --resume <id>       (continue it)
                             // default: true
  // Timeouts (seconds)
  idleTimeout?: number;      // stdout silence ceiling  (default 300)
  maxTimeout?: number;       // hard wall-clock ceiling (default 3600)
}
```

### ClaudeEvent union

All events extend `BaseEvent`:

```typescript
interface BaseEvent {
  seq: number;        // monotonically increasing within a run
  timestamp: number;  // Date.now() at parse time
  type: ClaudeEventType;
}

type ClaudeEvent =
  | TextEvent        // { type: 'text';       text: string }
  | ThinkingEvent    // { type: 'thinking';   thinking: string }
  | ToolUseEvent     // { type: 'tool_use';   id: string; name: string; input: unknown }
  | ToolResultEvent  // { type: 'tool_result'; toolUseId: string; isError: boolean; output: string }
  | ProgressEvent    // { type: 'progress';   elapsed: number }  — emitted every 5s by watchdog
  | ReadyEvent       // { type: 'ready';      sessionId: string; model?: string; tools?: string[] }
  | RetryEvent       // { type: 'retry';      attempt: number; delayMs?: number; error?: string }
  | DoneEvent        // { type: 'done';       sessionId: string; usage?: Usage }
  | ErrorEvent       // { type: 'error';      code: ErrorCode; detail: string; exitCode?: number }
  | RawEvent         // { type: 'raw';        rawType: string; rawSubtype?: string; data: unknown }
```

`ProgressEvent` is emitted by the watchdog every 5 seconds, independent of stdout activity. `elapsed` is seconds since process start. Use it for heartbeats, progress UI, or application-layer idle detection.

`ReadyEvent` fires from the `system/init` CLI event at process start — session ID and model are available here, before the final `done` event.

`RetryEvent` fires from `system/api_retry` — the CLI is retrying a failed API call.

`RawEvent` is the zero-loss fallback: any raw event type not explicitly handled (or any content block type not yet supported) is wrapped here. `data` contains the full raw JSON object. **No events are ever silently discarded.**

`DoneEvent.usage` shape:
```typescript
{
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}
```

```typescript
type ErrorCode =
  | 'idle_timeout'   // stdout silence exceeded idleTimeout
  | 'max_timeout'    // wall-clock ceiling exceeded
  | 'nonzero_exit'   // process exited with non-zero code
  | 'rate_limit'     // inline rate_limit_event or stderr pattern
  | 'stale_session'  // stderr: "No conversation found with session ID"
  | 'spawn_error'    // process could not be started (ENOENT, EACCES, etc.)
  | 'parse_error'    // line starts with '{' but is not valid JSON
  | 'cli_error'      // inline error/error_detail/error_event from the CLI stream
```

### Raw stream-json → ClaudeEvent mapping

| Raw type | Raw subtype / block type | Yields |
|---|---|---|
| `system` | `init` | `ReadyEvent` (sessionId, model, tool names) |
| `system` | `api_retry` | `RetryEvent` (attempt, delayMs, error) |
| `system` | any other subtype | `RawEvent` |
| `assistant` | `text` block | `TextEvent` |
| `assistant` | `thinking` block | `ThinkingEvent` |
| `assistant` | `tool_use` block | `ToolUseEvent` |
| `assistant` | `server_tool_use`, `redacted_thinking`, other | `RawEvent` (rawSubtype = block.type) |
| `assistant` | empty content array | `RawEvent` |
| `tool_result` | — | `ToolResultEvent` (direct, from `--verbose`) |
| `user` | — | `RawEvent` (full user turn preserved) |
| `result` | — | `DoneEvent` (sessionId + all usage fields incl. cache) |
| `rate_limit_event` | — | `ErrorEvent { code: 'rate_limit' }` |
| `error` / `error_detail` / `error_event` | — | `ErrorEvent { code: 'cli_error' }` |
| JSON line starting `{` that fails parse | — | `ErrorEvent { code: 'parse_error' }` |
| Non-JSON plaintext line | — | `TextEvent` |
| Any other type | — | `RawEvent` (generic fallback) |
| Watchdog tick (every 5s) | — | `ProgressEvent { elapsed }` |
| proc 'error' event (spawn failure) | — | `ErrorEvent { code: 'spawn_error' }` |
| stderr at exit: stale session keyword | — | `ErrorEvent { code: 'stale_session' }` |
| stderr at exit: rate limit keyword | — | `ErrorEvent { code: 'rate_limit' }` |
| Non-zero exit code, no stderr match | — | `ErrorEvent { code: 'nonzero_exit', exitCode }` |

### Session

```typescript
interface Session {
  key: string;            // app-defined key (CallSid, userId, path, task_id, …)
  cliSessionId?: string;  // assigned by the CLI, arrives in ReadyEvent and DoneEvent
  createdAt: string;      // ISO 8601
  lastActiveAt: string;   // ISO 8601; updated by touch() and recordCliSessionId()
  isFirst: boolean;       // true until recordCliSessionId() is called
}
```

### SessionManager

```typescript
class SessionManager {
  constructor(options: {
    persistPath?: string;  // file path for JSON store; omit for in-memory only
    namespace?: string;    // key prefix — isolates multiple managers in one file
  })

  newSession(key: string): Session
  resumeSession(key: string): Session | undefined
  listSessions(): Session[]              // returns only sessions in this namespace
  recordCliSessionId(key: string, cliSessionId: string): void  // call on DoneEvent
  touch(key: string): void
  clearSession(key: string): void
}
```

`FileStore.flush()` throws on write failure (disk full, permissions, etc.) — the error propagates through `set()` / `delete()` to the caller. `load()` silently starts empty on a missing or unreadable file (expected on first use).

### ISessionStore

```typescript
interface ISessionStore {
  get(key: string): Session | undefined;
  set(session: Session): void;    // throws on FileStore write failure
  delete(key: string): void;      // throws on FileStore write failure
  all(): Session[];               // sorted by lastActiveAt descending
}
```

Two implementations ship: `MemoryStore` (Map-backed) and `FileStore` (atomic JSON file via tmp+`renameSync`). `createSessionStore(persistPath?)` returns the appropriate one.

---

## Process lifecycle in detail

### CLI flag construction

```
[--agent <name>]               ← prepended first (unshift)
claude
  --print
  --verbose
  --output-format stream-json
  [--permission-mode bypassPermissions]  # if skipPermissions === true
  [--mcp-config <path>]                  # if options.mcpConfigPath is set
  [--session-id <id>]                    # first message with a non-undefined sessionId
  [--resume <id>]                        # subsequent messages
```

The prompt is written to `proc.stdin` directly (`write` + `end`). No positional stdin argument is passed to the CLI.

### CLAUDECODE environment deletion

The `CLAUDECODE` environment variable must be deleted before spawning, or the CLI refuses to run inside an existing Claude Code session:

```typescript
const env: NodeJS.ProcessEnv = { ...process.env };
delete env['CLAUDECODE'];
spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
```

### Watchdog, shared queue, and ProgressEvent

The watchdog (`setInterval`, 5s tick) and readline feed a shared async queue. The generator consumes from the queue, blocking only when empty:

```
readline 'line'  →  parseCliLine()  →  pushEvent(event)
watchdog tick    →  pushEvent(ProgressEvent)  →  check idle/max  →  maybe kill
readline 'close' →  pushEvent(null)   ← sentinel that ends the consume loop
proc 'error'     →  save spawnError   + pushEvent(null)
generator        →  while (true) { await waitForEvent(); item = queue.shift(); if null: break; yield item }
```

On timeout the watchdog sends SIGTERM, then schedules SIGKILL 3 seconds later via `setTimeout`. If the process exits cleanly from SIGTERM (the common case), the `setTimeout` is cleared in the `finally` block. If it ignores SIGTERM, SIGKILL fires and forces termination, closing stdout and draining the queue.

Exit precedence after queue drains:
1. `spawn_error` (proc 'error' event) — highest priority
2. `stale_session` (stderr match)
3. `rate_limit` (stderr match)
4. `idle_timeout` / `max_timeout` (watchdog triggered)
5. `nonzero_exit` (exit code ≠ 0, no match above)
6. Clean exit — generator ends normally

### Stale session recovery

The pattern below is caller-side pseudocode — it is **not exported from this module**.
Each caller implements their own version based on their session key strategy.

```typescript
async function* runWithRecovery(
  proc: CliProcess,
  sessions: SessionManager,
  key: string,
  opts: ProcessOptions,
): AsyncGenerator<ClaudeEvent> {
  for await (const event of proc.run(opts)) {
    if (event.type === 'error' && event.code === 'stale_session') {
      sessions.clearSession(key);
      yield* proc.run({ ...opts, sessionId: undefined, isFirstMessage: true });
      return;
    }
    yield event;
  }
}
```

---

## Use case: Documentation Robotics CLI

DR CLI is a TypeScript / Node.js project with a Hono + OpenAPI HTTP server, OTel instrumentation, and a `BaseChatClient` abstraction that wraps both Claude Code and GitHub Copilot.

### What code-wrapper covers

| DR CLI concern | code-wrapper feature |
|---|---|
| Spawning `claude --print --verbose --output-format stream-json` | `CliProcess.run(ProcessOptions)` |
| `CLAUDECODE` env deletion for nested execution | built into `CliProcess` |
| `--permission-mode bypassPermissions` flag | `ProcessOptions.skipPermissions` (opt-in; default `false`) |
| `--agent <name>` for skill invocation | `ProcessOptions.agent` |
| `--mcp-config <path>` | `ProcessOptions.mcpConfigPath` |
| `--session-id` (first message) vs `--resume` (resume) | `ProcessOptions.sessionId` + `isFirstMessage` |
| Two-tier idle / max timeout with SIGTERM → SIGKILL | `ProcessOptions.idleTimeout` + `maxTimeout` |
| Heartbeat during long tool calls | `ProgressEvent` every 5s |
| Spawn error capture (ENOENT, EACCES) | `ErrorEvent { code: 'spawn_error' }` |
| Line-by-line stdout parsing | `EventParser` (called by `CliProcess`) |
| Agent ready + early session ID | `ReadyEvent` (from `system/init`) |
| API retry visibility | `RetryEvent` (from `system/api_retry`) |
| Typed event stream: text, thinking, tool_use, tool_result, progress, ready, retry, done, error | `ClaudeEvent` union, `AsyncGenerator` |
| Zero-loss event capture (unknown types preserved) | `RawEvent` fallback |
| Monotonic `seq` for reliable replay / dedup | `BaseEvent.seq` |
| Inline CLI error events | `ErrorEvent { code: 'cli_error' }` |
| Inline rate limit events | `ErrorEvent { code: 'rate_limit' }` |
| Stale session detection | `ErrorEvent { code: 'stale_session' }` |
| Non-zero exit surfaced with code | `ErrorEvent { code: 'nonzero_exit', exitCode }` |
| Cache token accounting | `DoneEvent.usage.cacheReadInputTokens` / `cacheCreationInputTokens` |
| Session ID persistence (survives restarts) | `SessionManager` with `FileStore` |
| Namespace isolation for multi-tenant session files | `SessionManagerOptions.namespace` |
| `newSession / resumeSession / recordCliSessionId / clearSession` | `SessionManager` API |

### What code-wrapper does NOT cover (stays in DR CLI)

| DR CLI concern | Why it stays in DR CLI |
|---|---|
| `BaseChatClient` polymorphism | `CliProcess` handles one backend per instance; DR wraps it in a common interface |
| Copilot backend | Reserved for v2; throws on invocation |
| Hono + OpenAPI HTTP server | Application concern |
| OpenTelemetry tracing and metrics | Application concern; code-wrapper emits no spans |
| `ChatLogger` (durable local log file) | Destination-agnostic by design |
| SSE / WebSocket response streaming | Application concern |
| Session key scoping (by route, by user, by call) | App defines what a key is |

### Integration sketch

```typescript
import { CliProcess, SessionManager } from '@tinkermonkey/code-wrapper';

const proc = new CliProcess('claude');
const sessions = new SessionManager({ persistPath: './sessions.json' });

const session = sessions.resumeSession(callerId) ?? sessions.newSession(callerId);

for await (const event of proc.run({
  cwd: projectDir,
  prompt: userMessage,
  skipPermissions: true,
  sessionId: session.cliSessionId,
  isFirstMessage: session.isFirst,
})) {
  switch (event.type) {
    case 'ready':       onAgentReady(event.sessionId, event.model); break;
    case 'text':        sseStream.write(event.text); break;
    case 'thinking':    logger.debug('thinking', event.thinking.slice(0, 80)); break;
    case 'tool_use':    telemetry.toolCall(event.name); break;
    case 'progress':    heartbeat(event.elapsed); break;
    case 'retry':       logger.warn('api_retry', { attempt: event.attempt }); break;
    case 'done':        sessions.recordCliSessionId(callerId, event.sessionId); break;
    case 'error':
      if (event.code === 'stale_session') sessions.clearSession(callerId);
      logger.error(event.code, event.detail);
      break;
    case 'raw':         logger.debug('unhandled_cli_event', event.rawType); break;
  }
}
```

---

## Use case: Switchyard orchestrator

Switchyard is a Python-based CI/CD orchestrator. It runs Claude Code inside **Docker containers** (not as direct child processes), tails container stdout via `docker logs -f`, and sinks raw + enriched events to Redis Streams and pub/sub channels.

### Architecture note: Docker indirection

```
Switchyard (Python)
  └── docker run -d  ──▶  container
                              └── python docker-claude-wrapper.py
                                    └── claude --print --verbose --output-format stream-json
                                          │
                               container stdout
                                    │
  docker logs -f ◄──────────────────┘
        │
  read_stream() (Python, line by line) → stream_callback → Redis
```

### What code-wrapper covers (as reference patterns)

| Switchyard pattern | code-wrapper equivalent | Notes |
|---|---|---|
| `subprocess.Popen` + `stdout=PIPE` | `CliProcess` spawn + readline | Direct vs Docker-tailed; same line-by-line approach |
| `json.loads(line)` per line | `EventParser.parseCliLine()` | Same parsing logic |
| `stream_callback(event)` observer | `AsyncGenerator<ClaudeEvent>` | Pull vs push; same destination-agnostic principle |
| `system/init` → ready + session ID | `ReadyEvent` | Same data, normalized |
| `system/api_retry` → retry event | `RetryEvent` | Same data, normalized |
| `assistant/thinking` → thinking event | `ThinkingEvent` | Extended thinking content |
| `--resume <session_id>` | `ProcessOptions.sessionId` + `isFirstMessage: false` | code-wrapper also adds `--session-id` for traceable first messages |
| Two-phase cleanup (wait → kill) | Watchdog SIGTERM → 3s → SIGKILL | Same intent, same timing |
| `result` event for done signal | `DoneEvent` | Identical raw event type |
| `error`/`error_detail`/`error_event` | `ErrorEvent { code: 'cli_error' }` | Normalized |
| Rate-limit detection | `ErrorEvent { code: 'rate_limit' }` | Inline + stderr fallback |
| `session_id` from `result` | `DoneEvent.sessionId` | Also available earlier in `ReadyEvent` |
| `usage.*` incl. cache fields | `DoneEvent.usage` | All four fields extracted |
| Unknown/future event types | `RawEvent` | Switchyard drops; code-wrapper never drops |

### What code-wrapper does NOT cover (stays in Switchyard)

| Switchyard concern | Why it stays in Switchyard |
|---|---|
| Docker container launch and management | `CliProcess` spawns `claude` directly |
| `docker logs -f` tailing | Stdout comes from a container, not a direct child process |
| Task metadata enrichment (`task_id`, `project`, `pipeline_run_id`, …) | Application context |
| Redis XADD / PUBLISH sinks | Destination-agnostic by design |
| `ObservabilityEvent` taxonomy (30+ lifecycle types) | Orchestration-level, not CLI-level |
| Circuit breaker for rate limits | Recovery policy is the app's concern |
| Container tracking and result persistence | Infrastructure bookkeeping |

### Critical: language boundary

**Switchyard is Python. code-wrapper is Node.js. Switchyard cannot import it.**

| Path | When to use |
|---|---|
| **Codetoreum migration** (primary) | Switchyard's Node.js successor imports code-wrapper directly |
| **Reference implementation** (interim) | Switchyard's Python port adopts the same patterns without importing the module |
| **Sidecar bridge** (not recommended) | Node.js process bridging stdin/stdout; adds process hop; defer until Codetoreum is delayed |

---

## What the module deliberately does not own

| Concern | Rationale |
|---|---|
| Event routing (WebSocket, Redis, SSE, file) | Each caller routes differently |
| Threading / conversation structure | App decides what a thread is |
| Rate-limit recovery policy | Module surfaces the event; app decides to retry, queue, or reject |
| Hook interception | Project-level `.claude/` config, not driver code |
| Anthropic SDK / direct API streaming | CLI wrapper scope only |
| Docker / container management | Infrastructure layer |
| HTTP server, routes, auth | Application layer |
| Telemetry (OTel, Elastic, Prometheus) | Application observability layer |

---

## Known implementation gaps

| Gap | Description | Priority |
|---|---|---|
| `user` event ToolResultEvent extraction | `user` turn events are captured as `RawEvent`. When `--verbose` is active the CLI also emits top-level `tool_result` events (the canonical source). If the CLI does NOT emit top-level `tool_result` events in some configurations, tool results would only appear in `RawEvent.data`. | Low |
| Copilot backend | `CliProcess('copilot')` is declared but throws on use. Reserved for v2. | Future |
