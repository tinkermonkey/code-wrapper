# code-wrapper

Reusable Node.js / TypeScript module for apps that drive AI coding agent CLIs (Claude Code, GitHub Copilot). Handles three concerns that every such app reinvents:

1. **Process launch** — spawn the CLI in a working directory with the right flags, deliver the prompt via stdin, enforce idle and max timeouts
2. **Event normalization** — parse `--output-format stream-json` output into a typed, sequenced event stream; the caller routes events wherever it needs (WebSocket, Redis, SSE, in-process queue)
3. **Session management** — track conversation continuity across turns; persist session IDs to JSON so sessions survive restarts

## Install

```bash
npm install @tinkermonkey/code-wrapper
```

Requires Node.js ≥ 20 and `claude` (Claude Code) or `gh` (GitHub Copilot CLI) in your PATH.

## Quick start

```typescript
import { CliProcess, SessionManager } from '@tinkermonkey/code-wrapper';

const process = new CliProcess('claude');
const sessions = new SessionManager({ persistPath: './.sessions.json' });

// --- First turn ---
const session = sessions.newSession('user-123');

for await (const event of process.run({
  cwd: '/path/to/project',
  prompt: 'Summarise the architecture of this repo',
  skipPermissions: true,
  sessionId: session.cliSessionId,
  isFirstMessage: session.isFirst,
})) {
  if (event.type === 'text') {
    process.stdout.write(event.text);
  }
  if (event.type === 'done') {
    // Store the CLI-assigned session ID so the next turn uses --resume
    sessions.recordCliSessionId('user-123', event.sessionId);
  }
  if (event.type === 'error') {
    if (event.code === 'stale_session') {
      // CLI lost the session — clear it and retry
      sessions.clearSession('user-123');
    }
    console.error(event.code, event.detail);
  }
}

// --- Second turn (same conversation) ---
const existing = sessions.resumeSession('user-123');
if (existing) {
  for await (const event of process.run({
    cwd: '/path/to/project',
    prompt: 'Now focus on the auth layer',
    skipPermissions: true,
    sessionId: existing.cliSessionId,
    isFirstMessage: existing.isFirst,  // false — uses --resume
  })) {
    // handle events...
  }
}
```

## Event types

| `type` | Fields | When |
|---|---|---|
| `text` | `text` | Assistant prose chunk |
| `tool_use` | `id`, `name`, `inputSummary` | Claude called a tool |
| `tool_result` | `toolUseId`, `isError`, `output` | Tool returned |
| `done` | `sessionId`, `usage?` | Process exited cleanly |
| `error` | `code`, `detail`, `exitCode?` | See error codes below |

Error codes: `idle_timeout` · `max_timeout` · `nonzero_exit` · `rate_limit` · `stale_session` · `spawn_error` · `parse_error`

Every event carries `seq` (monotonic, safe for replay/dedup) and `timestamp`.

## ProcessOptions

| Option | Default | Description |
|---|---|---|
| `cwd` | required | Working directory for the CLI subprocess |
| `prompt` | required | Delivered via stdin |
| `agent` | — | Agent/skill name (e.g. `dr-architect`) |
| `skipPermissions` | `false` | Adds `--dangerously-skip-permissions` |
| `mcpConfigPath` | — | Path to MCP config JSON (`--mcp-config`) |
| `sessionId` | — | CLI session ID for continuity |
| `isFirstMessage` | `true` | `true` → `--session-id`; `false` → `--resume` |
| `idleTimeout` | `300` | Seconds of stdout silence before kill |
| `maxTimeout` | `3600` | Hard ceiling in seconds |

## Session helpers

```typescript
const sessions = new SessionManager({ persistPath: './.sessions.json' });

sessions.newSession(key)            // start fresh, overwrites existing
sessions.resumeSession(key)         // look up existing → undefined if none
sessions.listSessions()             // all sessions, newest first
sessions.recordCliSessionId(key, id) // call after each done event
sessions.touch(key)                 // update lastActiveAt
sessions.clearSession(key)          // remove (e.g. after stale_session error)
```

Omit `persistPath` to keep sessions in memory only.

## Source material

This module distils patterns from four existing projects:
- **phone-home** — two-tier timeout, stale-session retry, durable fan-out stream
- **switchyard** — robust output capture, pluggable observer
- **documentation_robotics CLI** — `BaseChatClient` abstraction, OTel, `--session-id` vs `--resume` distinction
- **pai / claude_investigation** — file-watcher JSONL sink, WebSocket snapshot-then-tail
