# code-wrapper exec Binary

The `code-wrapper exec` binary is the Phase 2 deliverable of the code-wrapper project. It's a standalone, compiled binary that manages all coding-agent protocol logic and exposes a clean NDJSON wire protocol on stdout.

## Overview

The binary is compiled from TypeScript using Bun's `--compile` feature, producing platform-specific standalone executables that require no Node.js runtime on the host. It wires together the existing TypeScript library's components:

- **CliProcess**: Spawns Claude Code or GitHub Copilot CLI
- **SessionManager**: Tracks conversation sessions across turns
- **EventParser**: Normalizes stream-json (Claude) and ACP JSON-RPC (Copilot) events
- **runWithRecovery()**: Handles stale-session detection and automatic retry

## Building the Binary

### Local Development

Compile for your current platform:

```bash
bun build --compile src/cli/exec.ts --outfile dist/code-wrapper
chmod +x dist/code-wrapper
```

Or use the provided build script for all platforms:

```bash
bash scripts/build-binary.sh
```

### Platform-Specific Targets

- **linux-x64**: `bun build --compile --target=bun-linux-x64 src/cli/exec.ts --outfile dist/code-wrapper-linux-x64`
- **linux-arm64**: `bun build --compile --target=bun-linux-arm64 src/cli/exec.ts --outfile dist/code-wrapper-linux-arm64`
- **darwin-x64**: `bun build --compile --target=bun-darwin-x64 src/cli/exec.ts --outfile dist/code-wrapper-darwin-x64`
- **darwin-arm64**: `bun build --compile --target=bun-darwin-arm64 src/cli/exec.ts --outfile dist/code-wrapper-darwin-arm64`

The GitHub Actions workflow (`.github/workflows/release-binaries.yml`) automatically compiles all four platform binaries on version tags and attaches them to the GitHub Release.

## Wire Protocol: NDJSON

The binary communicates exclusively through newline-delimited JSON (NDJSON) on stdout. Each line is a self-contained JSON object conforming to the `ClaudeEvent` schema.

### Protocol Format

Each event includes:

```json
{
  "v": 1,
  "seq": 0,
  "timestamp": 1724000000000,
  "type": "ready",
  "sessionId": "abc-123",
  "model": "claude-sonnet-4-20250514",
  "tools": ["Read", "Edit", "Bash"]
}
```

Key fields:
- **v**: Wire protocol version (currently 1). Consumers must check this field and raise an error on mismatch.
- **seq**: Monotonic sequence number for deduplication and replay
- **timestamp**: Unix timestamp in milliseconds
- **type**: Event type (ready, text, tool_use, tool_result, progress, done, error, raw, thinking, retry)

### Schema Validation

All emitted lines must validate against `schemas/claude-event.v1.schema.json`. The Python client validates the `v` field on the first event and raises `CodeWrapperProtocolError` on version mismatch.

## Invocation Interface

```bash
code-wrapper exec \
  --backend claude|copilot \
  --cwd /path/to/project \
  --session-id <id>           # for new sessions
  --resume <id>               # for resuming sessions
  --is-first-message          # flag, controls --session-id vs --resume
  --idle-timeout 300          # seconds, default 300
  --max-timeout 3600          # seconds, default 3600
  --skip-permissions          # flag
  --agent <name>              # optional
  --mcp-config <path>         # optional
  --session-dir <path>        # optional, for session persistence
  --recover-stale-session     # flag, enables stale-session recovery
  < prompt.txt                # prompt on stdin (or --prompt "inline")
```

### Arguments

| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `--backend` | claude\|copilot | claude | AI backend to use |
| `--cwd` | path | current dir | Working directory for the CLI |
| `--prompt` | string | stdin | Prompt to deliver (reads stdin if not provided) |
| `--session-id` | string | — | Start a new session with this ID |
| `--resume` | string | — | Resume an existing session with this ID |
| `--is-first-message` | flag | true | Set to true for new sessions |
| `--idle-timeout` | seconds | 300 | Timeout for stdout silence (SIGTERM) |
| `--max-timeout` | seconds | 3600 | Hard ceiling for run duration (SIGKILL) |
| `--skip-permissions` | flag | false | Pass --permission-mode bypassPermissions to CLI |
| `--agent` | string | — | Agent or skill to invoke (e.g., 'dr-architect') |
| `--mcp-config` | path | — | Path to MCP config JSON (--mcp-config flag) |
| `--session-dir` | path | — | Directory for session persistence |
| `--recover-stale-session` | flag | false | Enable automatic stale-session recovery |

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| **0** | Clean completion | DoneEvent was emitted; session finished normally |
| **1** | CLI error | ErrorEvent was emitted before exit (e.g., rate limit, spawn error) |
| **2** | Binary-level failure | No events emitted; binary crash or failed to spawn CLI (e.g., `claude` binary not found) |
| **3** | Wire protocol error | Internal bug (unexpected exception in generator) |

The Python client (`py-code-wrapper`) translates exit codes into exceptions:
- Code 2 → `CodeWrapperBinaryError`
- Code 3 → `CodeWrapperProtocolError`

## Process Group Management

On Unix-like systems, the binary establishes its own process group via `process.setpgid(0, 0)` so that the spawned CLI (and any of its children) are isolated. This ensures:

1. **SIGTERM forwarding**: The binary forwards SIGTERM to the entire process group, allowing clean shutdown of the CLI
2. **SIGKILL protection**: If the binary is forcibly killed, the OS reaps the entire group atomically

The Python client mirrors this pattern by spawning the binary with `start_new_session=True`, creating a second isolation boundary for extra safety.

### Timing

- **SIGTERM grace period**: 3 seconds (hardcoded in CliProcess)
- After 3 seconds without acknowledgment, SIGKILL is sent
- Exit code on SIGKILL: 143 (128 + 15)

## Session Management

Sessions track CLI-level conversation state. Each session has:

- **cliSessionId**: The ID assigned by the CLI (from the `ready` or `done` event)
- **isFirst**: Boolean flag controlling --session-id vs --resume
- **createdAt**: ISO timestamp
- **lastActiveAt**: ISO timestamp

### Session Lifecycle

**First message (new session):**
```
--session-id <uuid> --is-first-message
```
The CLI creates a new session and returns a `sessionId` in the `ready` event.

**Subsequent messages (resume):**
```
--resume <sessionId>
```
Pass the `sessionId` from the prior `done` event. The CLI reuses the session context.

### Stale Session Recovery

When `--recover-stale-session` is set with `--session-dir`:

1. Binary detects "No conversation found with session ID" error
2. Clears the stale session from the SessionManager
3. Retries once with `--session-id <new-uuid> --is-first-message`
4. All events from the retry are forwarded to the caller

## Backend Support

### Claude Backend

- Invoked as: `claude --print --output-format stream-json`
- Event format: stream-json (JSON objects, one per line)
- Parsed by: `parseCliLine()` and `EventParser`

### Copilot Backend (ACP)

- Invoked as: `copilot --acp --stdio`
- Event format: JSON-RPC 2.0 over stdin/stdout
- Handshake sequence:
  1. Binary sends `initialize` request
  2. Binary sends `session/new` request (loads persisted context if --resume used)
  3. Binary waits for `ready` event (sessionId from session/new ack)
  4. Binary sends `session/prompt` request (after consuming prompt from stdin)
  5. CLI sends `session/update` events (text, tool_use, etc.)
  6. CLI sends `session/idle` or `session/prompt` ack (dual-done-signal)
- Parsed by: `createCopilotAcpParser()` (stateful JSON-RPC parser)

Both backends produce identical `ClaudeEvent` streams to the caller.

## Testing

### Unit Tests

```bash
npm test
```

Runs test suite including:
- `exec-binary.test.ts`: Contract tests that spawn the binary and validate NDJSON output
- Fixture tests use `fake-claude.mjs` and `fake-copilot.mjs` to simulate backend behavior

### Integration Testing

Spawn the binary with a fake backend:

```bash
FAKE_SCENARIO=golden-path \
  PATH=/workspace/src/__tests__/fixtures:$PATH \
  node dist/cli/exec.js \
  --backend claude \
  --cwd /tmp \
  --prompt "Test prompt"
```

Available scenarios in fixtures:
- `golden-path`: Normal flow (init → text → tool_use → tool_result → result)
- `stall`: Emits init, then waits for SIGTERM
- `ignore-sigterm`: Emits init, ignores SIGTERM (tests SIGKILL escalation)
- `nonzero-exit`: Emits init, exits with code 1
- `stale-session`: Writes stale-session message to stderr
- `rate-limit`: Emits rate_limit_event, exits 1
- `session-resume`: Accepts --resume, emits session ID
- `api-retry`: Emits init + api_retry event + result
- `thinking`: Emits thinking block + text block + result
- `permission-request`: Emits init + permission request + result
- `multi-block`: Emits init + assistant with text+tool_use in one message + result

## Schema and Type Safety

The wire protocol schema is the source of truth for all event types:

```
src/events/types.ts  ──[generate-schema]──▶  schemas/claude-event.v1.schema.json
                                                     │
                            ┌────────────────────────┼────────────────────┐
                            ▼                        ▼                     ▼
                    TypeScript types          Python codegen        Contract tests
                    (compile-time check)   (datamodel-code-         (binary output
                                           generator)                 validation)
```

Schema generation is part of the build process:

```bash
npm run generate-schema
```

CI validates that the checked-in schema matches the current TypeScript types — a drift causes a build failure.

## Python Client Integration

The `py-code-wrapper` Python package provides a thin async generator wrapper:

```python
import asyncio
from py_code_wrapper import run

async def main():
    async for event in run(
        "Your prompt here",
        cwd="/path/to/project",
        backend="claude",
        session_id="my-session-123",
        is_first_message=True,
    ):
        match event.type:
            case "text":
                print(event.text)
            case "done":
                print(f"Cost: ${event.total_cost_usd}")
            case "error":
                raise RuntimeError(f"{event.code}: {event.detail}")

asyncio.run(main())
```

The Python client:
1. Resolves the binary path (env var → PATH → bundled)
2. Spawns the binary with `subprocess.create_subprocess_exec`
3. Reads stdout line-by-line, `json.loads()` each line
4. Checks `v` field on first event, raises error on mismatch
5. Deserializes into typed `ClaudeEvent` dataclasses
6. Yields events to the caller
7. On cancellation, sends SIGTERM then SIGKILL after grace period

## Distribution

### GitHub Releases

Each version tag triggers the GitHub Actions release workflow, which:
1. Compiles all four platform binaries
2. Attaches them as release assets (e.g., `code-wrapper-linux-x64`, `code-wrapper-darwin-arm64`)
3. Python package's `_binary.py` can download the matching binary on first use

### Docker

For Switchyard's Docker-based execution:
- Dockerfile copies the compiled binary to `/usr/local/bin/code-wrapper`
- Container entrypoint uses the binary instead of `docker-claude-wrapper.py`
- Output is clean NDJSON (no mixed plaintext/JSON)

### Ansible

Fleet management:
- Ansible role installs platform-specific binary to all managed hosts
- Updates via standard package management (pin version in role variables)

## Debugging

### Stderr Output

The binary writes diagnostic messages to stderr (not NDJSON):
- Errors finding the CLI binary
- Signal handling logs (on verbose platforms)
- Plugin loading failures (MCP servers)

### Enable Debug Output

Set `DEBUG=code-wrapper:*` or `DEBUG=*` to see internal logs on stderr:

```bash
DEBUG=* code-wrapper exec --backend claude --cwd /tmp --prompt "Test"
```

### Inspect NDJSON Output

Use standard tools to inspect the wire protocol:

```bash
code-wrapper exec ... | jq .
code-wrapper exec ... | python3 -m json.tool
```

## Performance

### Overhead

| Phase | Overhead | Notes |
|-------|----------|-------|
| Binary startup | 50-100ms (Bun SEA cold start) | Amortized over runs lasting seconds to minutes |
| JSON serialization | Negligible | One `JSON.stringify` per event |
| JSON deserialization (Python) | Negligible | One `json.loads` per line (stdlib) |
| Process group setup | ~1ms (`setsid()`) | One-time per run |

### Scaling

The binary adds one process hop compared to direct CLI invocation, but:
- No additional latency during the run (only at startup and shutdown)
- Scales identically to CliProcess (spawns same CLI with same args)
- No serialization overhead (events are small, < 1KB each)

## Troubleshooting

### "Binary not found" (exit code 2)

```
ERROR: Could not find claude binary in PATH
```

**Solution:** Ensure `claude` or `copilot` is installed and in PATH:

```bash
which claude
export PATH="/path/to/cli:$PATH"
```

### "No conversation found with session ID" (error event)

The session on the CLI has been cleared (likely due to inactivity or server restart).

**Solution:** Use `--recover-stale-session` flag to auto-retry with a fresh session, or clear your session tracker and start a new session.

### "Wire protocol version mismatch" (Python client error)

The binary is emitting a different `v` value than the schema expects.

**Solution:** Update both the binary and Python client to matching versions. Check `git log --oneline` to find the matching release.

## Contributing

Changes to the binary protocol:
1. Update `src/events/types.ts`
2. Run `npm run generate-schema` to regenerate schema
3. Increment the `v` field in the schema if the change is breaking
4. Update this documentation
5. Add contract tests in `src/__tests__/exec-binary.test.ts`
6. Tag a new release; GitHub Actions will compile and attach binaries

For Phase 3 (Python client) and Phase 4 (Switchyard migration), see the parent repository's ROADMAP.

---

_Documentation for code-wrapper Phase 2 executable_
