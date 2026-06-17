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
 │      ├── stderr ── buffered; checked after readline ends    │
 │      │             • "No conversation found" → stale_session│
 │      │             • rate limit message → rate_limit        │
 │      │                                                      │
 │      ├── exitCode ── awaited after readline ends            │
 │      │             • non-zero (no stderr match) → nonzero_exit│
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

> **External kill**: If the caller invokes `proc.kill()` directly, `killedBy` is never set.
> The generator terminates after readline closes. If the process exits non-zero, a
> `nonzero_exit` error is still yielded via the exit code check.

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

`--session-id` and `--resume` are distinct CLI flags. `--session-id` starts a fresh session with a caller-supplied traceable ID. `--resume` continues an existing session. When `sessionId` is `undefined` (very first turn), neither flag is passed — the CLI starts an anonymous session and returns the assigned ID in the `result` event.

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

`DoneEvent.usage` shape:
```typescript
{
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;     // present when prompt cache was read
  cacheCreationInputTokens?: number; // present when a new cache entry was created
}
```

`ToolUseEvent.input` is the raw tool input object as received from the CLI (`unknown` —
shape is tool-specific). `ToolResultEvent.output` is the full combined text from all
content blocks. Both are unsized — callers sinking to size-constrained destinations
(Redis, WebSocket) are responsible for their own truncation.

```typescript
type ErrorCode =
  | 'idle_timeout'   // stdout silence exceeded idleTimeout
  | 'max_timeout'    // wall-clock ceiling exceeded
  | 'nonzero_exit'   // process exited with non-zero code
  | 'rate_limit'     // stderr contained a rate-limit reset message
  | 'stale_session'  // stderr: "No conversation found with session ID"
  | 'spawn_error'    // process could not be started
  | 'parse_error'    // line starts with '{' but is not valid JSON
  | 'cli_error'      // inline error/error_detail/error_event from the CLI stream
```

### Raw stream-json → ClaudeEvent mapping

| Raw type | Fields extracted | Yields |
|---|---|---|
| `assistant` | `message.content[].type === 'text'` → `.text` | `TextEvent` per text block |
| `assistant` | `message.content[].type === 'tool_use'` | `ToolUseEvent` per tool-use block |
| `tool_result` | `tool_use_id`, `content[].text`, `is_error` | `ToolResultEvent` |
| `result` | `session_id`, all `usage.*` fields incl. cache | `DoneEvent` |
| `error` / `error_detail` / `error_event` | `message` or `error` string | `ErrorEvent { code: 'cli_error' }` |
| `user` | *(input echo)* | dropped |
| `system` | *(CLI bookkeeping)* | dropped |
| JSON line starting `{` that fails parse | raw line (first 200 chars) | `ErrorEvent { code: 'parse_error' }` |
| Non-JSON plaintext line | raw text | `TextEvent` |
| stderr at exit: stale session keyword | — | `ErrorEvent { code: 'stale_session' }` |
| stderr at exit: rate limit keyword | — | `ErrorEvent { code: 'rate_limit' }` |
| Non-zero exit code, no stderr match | exit code | `ErrorEvent { code: 'nonzero_exit', exitCode }` |

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
  [--dangerously-skip-permissions]   # if skipPermissions === true (not the default)
  [--mcp-config <path>]              # if options.mcpConfigPath is set
  [--session-id <id>]                # first message with a non-undefined sessionId
  [--resume <id>]                    # subsequent messages
  -                                  # read prompt from stdin
```

### CLAUDECODE environment deletion

The `CLAUDECODE` environment variable must be deleted before spawning, or the CLI refuses to run inside an existing Claude Code session:

```typescript
const env: NodeJS.ProcessEnv = { ...process.env };
delete env['CLAUDECODE'];
spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
```

### Watchdog and exit code handling

A `setInterval` ticks every 5 seconds and enforces two deadlines (idle, max). After the readline loop ends (stdout closed), `CliProcess` awaits `exitPromise` to capture the process exit code before surfacing any error. Precedence:

1. `stale_session` (stderr match) — highest priority
2. `rate_limit` (stderr match)
3. `idle_timeout` / `max_timeout` (watchdog triggered)
4. `nonzero_exit` (exit code ≠ 0, no match above)
5. Clean exit — generator ends normally

### Stale session recovery

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
| `--dangerously-skip-permissions` flag | `ProcessOptions.skipPermissions` (opt-in; default `false`) |
| `--agent <name>` for skill invocation | `ProcessOptions.agent` |
| `--mcp-config <path>` | `ProcessOptions.mcpConfigPath` |
| `--session-id` (first message) vs `--resume` (resume) | `ProcessOptions.sessionId` + `isFirstMessage` |
| Two-tier idle / max timeout with watchdog | `ProcessOptions.idleTimeout` + `maxTimeout` |
| Line-by-line stdout parsing | `EventParser` (called by `CliProcess`) |
| Typed event stream: text, tool_use, tool_result, done, error | `ClaudeEvent` union, `AsyncGenerator` |
| Monotonic `seq` for reliable replay / dedup | `BaseEvent.seq` |
| Inline CLI error events (`error`/`error_detail`/`error_event`) | `ErrorEvent { code: 'cli_error' }` |
| Stale session detection | `ErrorEvent { code: 'stale_session' }` |
| Rate limit detection | `ErrorEvent { code: 'rate_limit' }` |
| Non-zero exit surfaced with code | `ErrorEvent { code: 'nonzero_exit', exitCode }` |
| Cache token accounting | `DoneEvent.usage.cacheReadInputTokens` / `cacheCreationInputTokens` |
| Session ID persistence (survives restarts) | `SessionManager` with `FileStore` |
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
  if (event.type === 'text') sseStream.write(event.text);
  if (event.type === 'done') sessions.recordCliSessionId(callerId, event.sessionId);
  if (event.type === 'error') {
    if (event.code === 'stale_session') sessions.clearSession(callerId);
    logger.error(event.code, event.detail);
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
| `--resume <session_id>` | `ProcessOptions.sessionId` + `isFirstMessage: false` | code-wrapper also adds `--session-id` for traceable first messages |
| Two-phase cleanup (wait 30s → kill) | Watchdog SIGTERM → 3s → SIGKILL | Same intent |
| `result` event for done signal | `DoneEvent` | Identical raw event type |
| `error`/`error_detail`/`error_event` | `ErrorEvent { code: 'cli_error' }` | Normalized; Switchyard checks raw `type` string |
| Rate-limit detection | `ErrorEvent { code: 'rate_limit' }` | Switchyard adds circuit breaker on top |
| `session_id` from `result` | `DoneEvent.sessionId` | Same field, same timing |
| `usage.*` incl. cache fields | `DoneEvent.usage` | All four fields extracted |

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
| `ProgressEvent` not emitted | Defined in `types.ts` with `elapsed: number`. Intended for periodic watchdog heartbeats. Not yet emitted by `CliProcess`. | Low |
| Copilot backend | `CliProcess('copilot')` is declared but throws on use. Reserved for v2. | Future |
