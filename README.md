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

const session = sessions.resumeSession(callerId) ?? sessions.newSession(callerId);

for await (const event of proc.run({
  cwd: '/path/to/project',
  prompt: userMessage,
  skipPermissions: true,
  sessionId: session.cliSessionId,   // undefined on first turn — no session flag passed
  isFirstMessage: session.isFirst,   // true → --session-id; false → --resume
})) {
  switch (event.type) {
    case 'ready':
      console.log('Agent ready, session:', event.sessionId, 'model:', event.model);
      break;
    case 'text':
      process.stdout.write(event.text);
      break;
    case 'thinking':
      console.log('Thinking:', event.thinking.slice(0, 80));
      break;
    case 'tool_use':
      console.log('Tool:', event.name, event.input);
      break;
    case 'tool_result':
      console.log('Result:', event.output);
      break;
    case 'retry':
      console.log(`API retry #${event.attempt}`, event.error);
      break;
    case 'done':
      sessions.recordCliSessionId(callerId, event.sessionId);
      console.log('Tokens:', event.usage);
      break;
    case 'error':
      if (event.code === 'stale_session') sessions.clearSession(callerId);
      console.error(event.code, event.detail);
      break;
    case 'raw':
      // Unrecognized CLI event — inspect rawType/rawSubtype if needed
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

All events carry `seq: number` (monotonic within a run) and `timestamp: number`.

| Type | Key fields | Notes |
|---|---|---|
| `text` | `text: string` | Assistant text output |
| `thinking` | `thinking: string` | Extended thinking content |
| `tool_use` | `id`, `name`, `input: unknown` | Tool call by the agent |
| `tool_result` | `toolUseId`, `isError`, `output: string` | Tool execution result |
| `ready` | `sessionId`, `model?`, `tools?: string[]` | Fires at process start; session ID available immediately |
| `retry` | `attempt`, `delayMs?`, `error?` | CLI retrying a failed API call |
| `done` | `sessionId`, `usage?` | Run complete — store `sessionId` for next turn |
| `error` | `code: ErrorCode`, `detail`, `exitCode?` | See ErrorCode table |
| `raw` | `rawType`, `rawSubtype?`, `data: unknown` | Unrecognized CLI event — nothing is silently discarded |
| `progress` | `elapsed: number` | Defined; not yet emitted |

### ErrorCode values

| Code | When |
|---|---|
| `idle_timeout` | No stdout for `idleTimeout` seconds |
| `max_timeout` | Wall-clock exceeded `maxTimeout` |
| `nonzero_exit` | Process exited with non-zero code |
| `rate_limit` | CLI hit its API rate limit (inline `rate_limit_event` or stderr pattern) |
| `stale_session` | CLI reported the session ID is unknown |
| `spawn_error` | Process could not be started |
| `parse_error` | Line starts with `{` but is not valid JSON |
| `cli_error` | Inline `error`/`error_detail`/`error_event` from the CLI stream |

## ProcessOptions

| Field | Default | Description |
|---|---|---|
| `cwd` | required | Working directory for the CLI |
| `prompt` | required | Delivered via stdin |
| `skipPermissions` | `false` | Pass `--permission-mode bypassPermissions` |
| `agent` | — | `--agent <name>` (prepended first) |
| `mcpConfigPath` | — | `--mcp-config <path>` |
| `sessionId` | — | CLI session ID for continuity |
| `isFirstMessage` | `true` | `true` → `--session-id`; `false` → `--resume` |
| `idleTimeout` | `300` | Seconds of stdout silence before kill |
| `maxTimeout` | `3600` | Hard ceiling in seconds |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full design details, interface specs, and use-case mapping.

## Testing

### Fast suite

```sh
npm test
```

Runs offline unit tests. No credentials, no live binaries, no network access required.

### Live suite

```sh
npm run test:live
```

Exercises real CLI processes. Prerequisites:

**Claude tests** — requires all of:
- `claude` CLI in PATH
- `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` set in the environment

**Copilot tests** — requires all of:
- `copilot` CLI installed (`gh extension install github/gh-copilot`)
- Active GitHub Copilot session (`gh auth login`)

#### Graceful skipping

When prerequisites are absent the relevant `describe` block is skipped — it does **not** fail. Seeing output like `0 tests passed, 6 skipped` is expected and correct when the CLI is unavailable or credentials are not set.

### Running a single test file

```sh
npx vitest run src/__tests__/live/claude.live.test.ts --config vitest.config.live.ts
npx vitest run src/__tests__/live/copilot.live.test.ts --config vitest.config.live.ts
```
