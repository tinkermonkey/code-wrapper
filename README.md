# @tinkermonkey/code-wrapper

Reusable Node.js module for apps that wrap an AI coding agent CLI. Handles the three universal concerns:

1. **Process launch** — spawn `claude` or `gh copilot`, deliver prompt via stdin, enforce idle and max timeouts, tear down cleanly
2. **Event normalization** — parse `--output-format stream-json` output into a typed `ClaudeEvent` stream with a monotonic `seq` on every event
3. **Session management** — track CLI session IDs across turns, persist them to disk, detect and recover from stale sessions

## Requirements

- Node.js ≥ 20
- `claude` CLI in PATH (or `gh` for Copilot, once implemented)

## Install

```sh
# From npm (once published)
npm install @tinkermonkey/code-wrapper

# From GitHub
npm install github:tinkermonkey/code-wrapper
```

## Build

```sh
npm run build        # compile TypeScript → dist/
npm run typecheck    # type-check without emitting
```

The `prepare` script runs `build` automatically on `npm install` from a git URL.

## Quick start

```typescript
import { CliProcess, SessionManager } from '@tinkermonkey/code-wrapper';

const proc = new CliProcess('claude');
const sessions = new SessionManager({ persistPath: './sessions.json' });

// Start or resume a conversation keyed by any app-defined string
const session = sessions.resumeSession(callerId) ?? sessions.newSession(callerId);

for await (const event of proc.run({
  cwd: '/path/to/project',
  prompt: userMessage,
  skipPermissions: true,
  sessionId: session.cliSessionId,   // undefined on first turn — no session flag passed
  isFirstMessage: session.isFirst,   // true → --session-id; false → --resume
})) {
  switch (event.type) {
    case 'text':        process.stdout.write(event.text); break;
    case 'tool_use':    console.log('Tool:', event.name, event.input); break;
    case 'tool_result': console.log('Result:', event.output); break;
    case 'done':
      sessions.recordCliSessionId(callerId, event.sessionId);
      console.log('Tokens:', event.usage);
      break;
    case 'error':
      if (event.code === 'stale_session') sessions.clearSession(callerId);
      console.error(event.code, event.detail);
      break;
  }
}
```

## Module paths

| Import | Exports |
|---|---|
| `@tinkermonkey/code-wrapper` | Everything below, re-exported |
| `@tinkermonkey/code-wrapper/process` | `CliProcess`, `ProcessOptions`, `CliBackend` |
| `@tinkermonkey/code-wrapper/events` | `parseCliLine`, `ClaudeEvent` union + all event types |
| `@tinkermonkey/code-wrapper/sessions` | `SessionManager`, `createSessionStore`, `Session` |

## Event types

| Type | Key fields |
|---|---|
| `text` | `text: string` |
| `tool_use` | `id`, `name`, `input: unknown` |
| `tool_result` | `toolUseId`, `isError`, `output: string` |
| `done` | `sessionId`, `usage?: { inputTokens, outputTokens, cacheReadInputTokens?, cacheCreationInputTokens? }` |
| `error` | `code: ErrorCode`, `detail: string`, `exitCode?: number` |
| `progress` | `elapsed: number` — defined; not yet emitted |

All events carry `seq: number` (monotonic within a run) and `timestamp: number`.

### ErrorCode values

| Code | When |
|---|---|
| `idle_timeout` | No stdout for `idleTimeout` seconds |
| `max_timeout` | Wall-clock exceeded `maxTimeout` |
| `nonzero_exit` | Process exited with non-zero code |
| `rate_limit` | CLI hit its API rate limit |
| `stale_session` | CLI reported the session ID is unknown |
| `spawn_error` | Process could not be started |
| `parse_error` | Line starts with `{` but is not valid JSON |
| `cli_error` | Inline `error`/`error_detail`/`error_event` from the CLI stream |

## ProcessOptions

| Field | Default | Description |
|---|---|---|
| `cwd` | required | Working directory for the CLI |
| `prompt` | required | Delivered via stdin |
| `skipPermissions` | `false` | Pass `--dangerously-skip-permissions` |
| `agent` | — | `--agent <name>` (prepended first) |
| `mcpConfigPath` | — | `--mcp-config <path>` |
| `sessionId` | — | CLI session ID for continuity |
| `isFirstMessage` | `true` | `true` → `--session-id`; `false` → `--resume` |
| `idleTimeout` | `300` | Seconds of stdout silence before kill |
| `maxTimeout` | `3600` | Hard ceiling in seconds |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full design details, interface specs, and use-case mapping.
