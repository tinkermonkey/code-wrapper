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
 │      ├── stdin ◄── options.prompt                          │
 │      │                                                      │
 │      ├── stdout ──▶ readline (line by line)                │
 │      │                  │                                   │
 │      │                  ▼                                   │
 │      │           EventParser.parseCliLine(line, seq)        │
 │      │                  │                                   │
 │      │                  ▼                                   │
 │      │           ClaudeEvent[]  (0, 1, or many per line)   │
 │      │                  │                                   │
 │      │                  ▼                                   │
 │      │           yield ──▶ AsyncGenerator<ClaudeEvent>      │
 │      │                                                      │
 │      ├── stderr ── buffered, checked at exit                │
 │      │             • "No conversation found" → stale_session│
 │      │             • rate limit message → rate_limit        │
 │      │                                                      │
 │      └── watchdog (setInterval, 5s tick)                   │
 │               • idle timeout (stdout silence > N s)         │
 │               • max timeout (wall clock > M s)              │
 │               • SIGTERM → wait 3 s → SIGKILL               │
 │               • process death closes stdout                 │
 │               • readline 'close' ends the generator         │
 └─────────────────────────────────────────────────────────────┘
                │
                ▼
       caller iterates: for await (const event of process.run(opts))
       caller routes:   WebSocket / Redis / SSE / in-process queue
```

> **External kill**: If the caller invokes `proc.kill()` directly, `killedBy` is never set,
> so none of the timeout error branches fire. The generator terminates after the readline
> `'close'` event with no final `ErrorEvent`. The caller is responsible for noting the
> cancellation in its own state.

---

## Key interfaces

### ProcessOptions

```typescript
type CliBackend = 'claude' | 'copilot';

interface ProcessOptions {
  cwd: string;               // working directory for the CLI
  prompt: string;            // delivered via stdin
  agent?: string;            // --agent <name>  (prepended before all other flags)
  skipPermissions?: boolean; // --dangerously-skip-permissions (default false)
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

`--session-id` and `--resume` are distinct CLI flags. `--session-id` starts a fresh session with a caller-supplied traceable ID. `--resume` continues an existing session. The `isFirstMessage` boolean controls which flag is passed. When `sessionId` is `undefined` (e.g. the very first turn), neither flag is passed — the CLI starts an anonymous session and returns the assigned ID in the `result` event.

### ClaudeEvent union

All events extend `BaseEvent`:

```typescript
interface BaseEvent {
  seq: number;        // monotonically increasing within a run
  timestamp: number;  // Date.now() at parse time
  type: ClaudeEventType;
}

type ClaudeEvent =
  | TextEvent        // { type: 'text';        text: string }
  | ToolUseEvent     // { type: 'tool_use';    id: string; name: string; input: unknown }
  | ToolResultEvent  // { type: 'tool_result'; toolUseId: string; isError: boolean; output: string }
  | ProgressEvent    // { type: 'progress';    elapsed: number }  — defined; not yet emitted
  | DoneEvent        // { type: 'done';        sessionId: string; usage?: Usage }
  | ErrorEvent       // { type: 'error';       code: ErrorCode; detail: string; exitCode?: number }
```

`ToolUseEvent.input` is the raw tool input object as received from the CLI (type `unknown` —
the shape is tool-specific). `ToolResultEvent.output` is the full combined text from all
content blocks in the result. Both are unsized — callers that sink to size-constrained
destinations (e.g. Redis) are responsible for their own truncation or filtering.

```typescript
type ErrorCode =
  | 'idle_timeout'    // stdout silence exceeded idleTimeout
  | 'max_timeout'     // wall-clock ceiling exceeded
  | 'nonzero_exit'    // process exited with non-zero code (not covered above)
  | 'rate_limit'      // stderr contained a rate-limit reset message
  | 'stale_session'   // stderr: "No conversation found with session ID"
  | 'spawn_error'     // process could not be started at all
  | 'parse_error'     // reserved; not yet emitted (see Known gaps)
```

### Raw stream-json → ClaudeEvent mapping

| Raw type | Fields extracted | Yields |
|---|---|---|
| `assistant` | `message.content[].type === 'text'` → `.text` | `TextEvent` per text block |
| `assistant` | `message.content[].type === 'tool_use'` | `ToolUseEvent` per tool-use block |
| `tool_result` | `tool_use_id`, `content[].text`, `is_error` | `ToolResultEvent` |
| `result` | `session_id`, `usage.input_tokens`, `usage.output_tokens` | `DoneEvent` (also signals watchdog to disarm) |
| `user` | *(input echo)* | dropped |
| `system` | *(CLI bookkeeping)* | dropped |
| `error` / `error_detail` / `error_event` | *(CLI error events)* | dropped — see Known gaps |
| non-JSON line | raw text | `TextEvent` (nothing silently dropped) |
| stderr at exit | rate-limit or stale-session keywords | `ErrorEvent` |

### Session

```typescript
interface Session {
  key: string;            // app-defined key (CallSid, userId, path, task_id, …)
  cliSessionId?: string;  // assigned by the CLI, arrives in DoneEvent.sessionId
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
    namespace?: string;    // key prefix to isolate multiple managers in one file
  })

  newSession(key: string): Session
  resumeSession(key: string): Session | undefined
  listSessions(): Session[]
  recordCliSessionId(key: string, cliSessionId: string): void  // call on DoneEvent
  touch(key: string): void                                     // update lastActiveAt
  clearSession(key: string): void                              // force-fresh on next call
}
```

### ISessionStore

```typescript
interface ISessionStore {
  get(key: string): Session | undefined;
  set(session: Session): void;    // key is session.key — not a separate parameter
  delete(key: string): void;
  all(): Session[];               // sorted by lastActiveActive descending
}
```

Two implementations ship: `MemoryStore` (Map-backed) and `FileStore` (atomic JSON file via tmp+`renameSync`). `createSessionStore(persistPath?)` returns the appropriate one.

---

## Process lifecycle in detail

### CLI flag construction

The actual argument order produced by `buildArgs`:

```
[--agent <name>]               ← prepended first if set (unshift)
claude
  --print
  --verbose
  --output-format stream-json
  [--dangerously-skip-permissions]   # if skipPermissions === true (not the default)
  [--mcp-config <path>]              # if options.mcpConfigPath is set
  [--session-id <id>]                # first message with a non-undefined sessionId
  [--resume <id>]                    # subsequent messages
  -                                  # read prompt from stdin
```

Note: `--dangerously-skip-permissions` is opt-in (`skipPermissions` defaults to `false`).
Note: `--agent` is added via `args.unshift` so it is always the first argument.

### CLAUDECODE environment deletion

The `CLAUDECODE` environment variable is set by Claude Code when it runs. A subprocess spawned inside an existing Claude Code session will refuse to start if this variable is present. `CliProcess` deletes it from the child's environment before spawning:

```typescript
const env: NodeJS.ProcessEnv = { ...process.env };
delete env['CLAUDECODE'];
spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
```

This is required for DR CLI (which runs inside a Claude Code session as a tool) and for phone-home (which runs inside the control-plane container). Switchyard runs Claude inside Docker containers where this is not an issue — but deleting the variable costs nothing.

### Watchdog timer

A `setInterval` ticks every 5 seconds and tracks two deadlines:

- **Idle timeout** — last stdout activity was more than `idleTimeout` seconds ago → kill, then yield `ErrorEvent { code: 'idle_timeout' }`
- **Max timeout** — total elapsed time exceeds `maxTimeout` → kill, then yield `ErrorEvent { code: 'max_timeout' }`

Killing the process closes its stdout pipe, which fires the readline `'close'` event, which terminates the generator loop naturally. No manual generator.return() call is needed.

After readline closes, the implementation checks stderr for well-known patterns:
1. Stale session (`STALE_SESSION_RE`) → `ErrorEvent { code: 'stale_session' }` (takes precedence)
2. Rate limit (`RATE_LIMIT_RE`) → `ErrorEvent { code: 'rate_limit' }` (takes precedence)
3. Watchdog kill → timeout error event
4. Non-zero exit with none of the above → generator ends cleanly (see Known gaps)

### Stale session recovery

The module surfaces stale sessions as `ErrorEvent { code: 'stale_session' }`. Recovery policy belongs to the caller:

```typescript
// Must be inside an async generator function to use yield*
async function* runWithRecovery(
  proc: CliProcess,
  sessions: SessionManager,
  key: string,
  opts: ProcessOptions,
): AsyncGenerator<ClaudeEvent> {
  for await (const event of proc.run(opts)) {
    if (event.type === 'error' && event.code === 'stale_session') {
      sessions.clearSession(key);           // drop the bad ID
      // Retry with no sessionId — CLI will start a fresh session
      yield* proc.run({ ...opts, sessionId: undefined, isFirstMessage: true });
      return;
    }
    yield event;
  }
}
```

The AI CLI Runner summary doc notes this explicitly: clearing and retrying is the correct recovery, not surfacing an error to the end user.

---

## Use case: Documentation Robotics CLI

DR CLI is a TypeScript / Node.js project with a Hono + OpenAPI HTTP server, OTel instrumentation, and a `BaseChatClient` abstraction that wraps both Claude Code and GitHub Copilot.

### What code-wrapper covers

| DR CLI concern | code-wrapper feature |
|---|---|
| Spawning `claude --print --verbose --output-format stream-json` | `CliProcess.run(ProcessOptions)` |
| `CLAUDECODE` env deletion for nested execution | built into `CliProcess` |
| `--dangerously-skip-permissions` flag | `ProcessOptions.skipPermissions` (pass `true` explicitly; default is `false`) |
| `--agent <name>` for skill invocation | `ProcessOptions.agent` |
| `--mcp-config <path>` | `ProcessOptions.mcpConfigPath` |
| `--session-id` (first message) vs `--resume` (resume) | `ProcessOptions.sessionId` + `isFirstMessage` |
| Two-tier idle / max timeout with watchdog | `ProcessOptions.idleTimeout` + `maxTimeout` |
| Line-by-line stdout parsing | `EventParser` (called by `CliProcess`) |
| Typed event stream: text, tool_use, tool_result, done, error | `ClaudeEvent` union, `AsyncGenerator` |
| Monotonic `seq` for reliable replay / dedup | `BaseEvent.seq` |
| Stale session detection and surfacing | `ErrorEvent { code: 'stale_session' }` |
| Rate limit detection and surfacing | `ErrorEvent { code: 'rate_limit' }` |
| Session ID persistence (survives restarts) | `SessionManager` with `FileStore` |
| `newSession / resumeSession / recordCliSessionId / clearSession` | `SessionManager` API |

### What code-wrapper does NOT cover (stays in DR CLI)

| DR CLI concern | Why it stays in DR CLI |
|---|---|
| `BaseChatClient` polymorphism (Claude Code + Copilot) | `CliProcess` handles one backend per instance; DR wraps it in a common interface keyed by backend type |
| Copilot backend | `CliProcess('copilot')` is defined but not yet implemented — throws on invocation; reserved for v2 |
| Hono + OpenAPI HTTP server | Framework and route handling are application concerns |
| OpenTelemetry tracing and metrics | Observability is the app's responsibility; code-wrapper emits no spans |
| `ChatLogger` (durable local log file) | Routing events to a log file is the caller's concern — the module is destination-agnostic |
| SSE / WebSocket response streaming | Event routing is the app's concern |
| Session key scoping (by route, by user, by call) | The app decides what a "key" is — code-wrapper just stores it |

### Integration sketch

```typescript
import { CliProcess, SessionManager } from '@tinkermonkey/code-wrapper';

const proc = new CliProcess('claude');
const sessions = new SessionManager({ persistPath: './sessions.json' });

// First call for a user
const session = sessions.newSession(callerId);
// On a brand-new session, cliSessionId is undefined.
// buildArgs skips both --session-id and --resume when sessionId is undefined.
const opts = {
  cwd: projectDir,
  prompt: userMessage,
  sessionId: session.cliSessionId,   // undefined → no session flag on first turn
  isFirstMessage: session.isFirst,   // true
};

for await (const event of proc.run(opts)) {
  if (event.type === 'text') sseStream.write(event.text);
  if (event.type === 'done') {
    // Store the CLI-assigned ID so the next turn uses --resume
    sessions.recordCliSessionId(callerId, event.sessionId);
  }
  if (event.type === 'error' && event.code === 'stale_session') {
    sessions.clearSession(callerId);
    // retry with fresh session
  }
  // log to ChatLogger, emit OTel span — DR CLI's responsibility
}
```

---

## Use case: Switchyard orchestrator

Switchyard is a Python-based CI/CD orchestrator. It runs Claude Code inside **Docker containers** (not as direct child processes), tails container stdout via `docker logs -f`, and sinks raw + enriched events to Redis Streams and pub/sub channels.

### Architecture note: Docker indirection

Switchyard's execution model differs from a direct subprocess in one fundamental way:

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
  read_stream() (Python, line by line)
        │
  json.loads()
        │
  stream_callback(event)
        │
  xadd / publish  ──▶  Redis
```

The module's `CliProcess` spawns the CLI directly and owns its stdout pipe. It cannot model the Docker layer in between.

### What code-wrapper covers (as reference patterns)

The conceptual patterns are identical even though the language and indirection differ:

| Switchyard pattern | code-wrapper equivalent | Notes |
|---|---|---|
| `subprocess.Popen` + `stdout=PIPE` | `CliProcess` spawn + readline | Direct vs Docker-tailed, but same line-by-line approach |
| `json.loads(line)` per line | `EventParser.parseCliLine()` | Same parsing logic |
| `stream_callback(event)` observer | `AsyncGenerator<ClaudeEvent>` | Pull vs push, same destination-agnostic principle |
| `--resume <session_id>` flag | `ProcessOptions.sessionId` + `isFirstMessage: false` | Switchyard only uses `--resume`; code-wrapper adds `--session-id` for traceable first messages |
| Two-phase cleanup (wait 30s → kill container) | Watchdog SIGTERM → 3s → SIGKILL | Same intent: graceful then forceful |
| `result` event detection for done signal | `DoneEvent` from EventParser | Identical raw event type |
| Error type detection (`error`, `error_detail`, `error_event`) | Currently silently dropped (see Known gaps) | Switchyard checks raw `type` string; code-wrapper needs this for parity |
| Rate-limit detection | `ErrorEvent { code: 'rate_limit' }` | Switchyard uses a circuit breaker on top; code-wrapper surfaces the event |
| `session_id` from `result` event | `DoneEvent.sessionId` | Same field, same timing |
| `usage.*` from `result` event | `DoneEvent.usage` | code-wrapper extracts from the terminal `result` event; Switchyard also reads per raw event |

### What code-wrapper does NOT cover (stays in Switchyard)

| Switchyard concern | Why it stays in Switchyard |
|---|---|
| Docker container launch and management | `CliProcess` spawns `claude` directly; it has no `docker run` abstraction |
| `docker logs -f` tailing | Stdout comes from a container, not a direct child process |
| Task metadata enrichment (`agent`, `task_id`, `project`, `issue_number`, `pipeline_run_id`) | Application context that the wrapper adds to each event before sinking to Redis |
| Redis XADD / PUBLISH sinks | Event routing is destination-agnostic in code-wrapper |
| `ObservabilityEvent` taxonomy (30+ lifecycle types) | Orchestration-level events (PIPELINE_RUN_*, REPAIR_CYCLE_*, REVIEW_CYCLE_*, etc.) are not CLI-level events |
| Circuit breaker for rate limits | Recovery policy is the app's concern; code-wrapper surfaces the `rate_limit` error code |
| Two Redis channels (`claude_logs_stream` + `agent_events`) | Multiple sinks and pub/sub fan-out are the app's routing layer |
| Container tracking Redis hashes | Infrastructure bookkeeping outside the CLI concern |
| `agent_result:{project}:{issue}:{task_id}` final result key | Result persistence is Switchyard's contract with its consumers |

### Critical: language boundary

**Switchyard is Python. code-wrapper is a Node.js module. Switchyard cannot import it.**

This is not a gap in the module's design — it is a language boundary. There are three resolution paths:

#### Path 1 — Codetoreum migration (primary)

Codetoreum is Switchyard's planned Node.js successor. When Codetoreum replaces Switchyard's orchestration layer, it will be able to import `@tinkermonkey/code-wrapper` directly and eliminate the bespoke Python subprocess / Docker-tailing stack. This is the intended end state.

```typescript
// Codetoreum (future)
import { CliProcess, SessionManager } from '@tinkermonkey/code-wrapper';
// No Python, no docker-claude-wrapper.py, no docker logs -f needed
```

#### Path 2 — Reference implementation (interim)

While Switchyard's Python codebase remains active, code-wrapper serves as the **canonical reference** for:
- The correct event normalization mapping (raw type → typed event)
- The `--session-id` vs `--resume` distinction Switchyard currently misses
- The two-tier watchdog timeout pattern
- The stale session recovery protocol

Switchyard can adopt these patterns in Python without importing the module.

#### Path 3 — Sidecar bridge (not recommended)

A thin Node.js process could accept a JSON envelope on stdin (`{ cwd, prompt, sessionId, isFirstMessage }`) and emit `ClaudeEvent` NDJSON on stdout. Switchyard would spawn this sidecar and pipe through it. This is architecturally sound but adds a runtime dependency and process hop that the Codetoreum migration makes unnecessary. Only consider this if Codetoreum is significantly delayed and Switchyard needs `--session-id` support or stale session recovery before then.

---

## What the module deliberately does not own

These are explicitly out of scope for all callers:

| Concern | Rationale |
|---|---|
| Event routing (WebSocket, Redis, SSE, file) | Each caller routes differently; picking one would exclude the others |
| Threading / conversation structure | phone-home keys by CallSid; DR keys by session; Switchyard keys by task_id; the module accepts a `key` string and does no more |
| Rate-limit recovery policy | The module surfaces the event; whether to retry, queue, or reject is the app's decision |
| Hook interception | Claude Code lifecycle hooks are project-level `.claude/` config, not driver code |
| Anthropic SDK / direct API streaming | Scope is CLI wrappers; SDK path is a different abstraction |
| Docker / container management | Infrastructure below or above the CLI invocation layer |
| HTTP server, routes, auth | Application layer |
| Telemetry (OTel, Elastic, Prometheus) | Application observability layer |

---

## Known implementation gaps

These are gaps between the current implementation and what a complete solution would include.
Each is intentionally deferred, not forgotten.

| Gap | Description | Priority |
|---|---|---|
| `error`/`error_detail`/`error_event` raw types | Inline CLI error events are silently dropped by EventParser. They should be surfaced as `ErrorEvent`. | High |
| Cache token fields in `DoneEvent.usage` | The CLI's `result` event includes `cache_read_input_tokens` and `cache_creation_input_tokens`. EventParser drops them; `DoneEvent.usage` should be extended to include `cacheReadInputTokens` and `cacheCreationInputTokens`. | Medium |
| `parse_error` ErrorCode | Defined in `ErrorCode` but never emitted. Intended for lines that begin with `{` but are not valid JSON (as distinct from plaintext lines, which become `TextEvent`). | Low |
| `ProgressEvent` not emitted | Defined in `types.ts` with `elapsed: number` (seconds since process start). Intended for periodic watchdog heartbeats. Not yet emitted by `CliProcess`. | Low |
| `nonzero_exit` not emitted | `ErrorCode` defines `nonzero_exit` but `CliProcess` does not check the exit code and emit this event. A non-zero exit with no matching stderr pattern ends the generator silently. | Medium |
| Copilot backend | `CliProcess('copilot')` is declared but throws on use. Reserved for v2. | Future |
