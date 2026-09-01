# py-code-wrapper

Python async client for code-wrapper binary. A thin wrapper that spawns the compiled `code-wrapper` binary and exposes an async generator over its NDJSON output.

The client contains zero protocol knowledge — it only:
1. Resolves the binary (from env var, PATH, or package bundled)
2. Manages the subprocess lifecycle (spawn, SIGTERM→SIGKILL)
3. Deserializes JSON lines into typed Pydantic models
4. Checks wire protocol version on first event

## Installation

```bash
pip install py-code-wrapper
```

## Usage

### Basic example

```python
import asyncio
from code_wrapper import CodeWrapper, ClientOptions

async def main():
    options = ClientOptions(
        cwd="/workspace",
        prompt="What is the meaning of life?",
    )
    
    client = CodeWrapper()
    async for event in client.run(options):
        print(f"{event.type}: {event}")

asyncio.run(main())
```

### With session resumption

```python
from code_wrapper import CodeWrapper, ClientOptions, SessionTracker, DoneEvent

async def chat(user_id: str, prompt: str):
    tracker = SessionTracker()
    
    # Get session kwargs (session_id and is_first_message for resumption)
    session_kwargs = tracker.get_run_kwargs(user_id)
    
    options = ClientOptions(
        cwd="/workspace",
        prompt=prompt,
        session_dir="./sessions",        # Binary persists session data here
        recover_stale_session=True,      # Recover if session is stale
        **session_kwargs,                # Unpacks session_id and is_first_message
    )
    
    client = CodeWrapper()
    async for event in client.run(options):
        if event.type == "done":
            # Record the session ID for next turn
            tracker.record_done(user_id, event.sessionId)
        print(f"{event.type}: {event}")
```

### Handling errors

```python
from code_wrapper import (
    CodeWrapper, ClientOptions, CodeWrapperBinaryError, CodeWrapperProtocolError
)

try:
    client = CodeWrapper()
    async for event in client.run(options):
        pass
except CodeWrapperBinaryError as e:
    # Binary not found or failed to execute
    print(f"Binary error: {e}")
except CodeWrapperProtocolError as e:
    # Wire protocol version mismatch
    print(f"Protocol error: {e}")
```

## Event Types

All events inherit from `BaseEvent` with fields:
- `v`: Wire protocol version (1)
- `seq`: Monotonically increasing sequence number
- `timestamp`: Unix timestamp in milliseconds
- `type`: Event type discriminator

Specific event types:

- `TextEvent`: Text content from the assistant
- `ThinkingEvent`: Extended thinking content
- `ToolUseEvent`: Tool use request (id, name, input)
- `ToolResultEvent`: Tool execution result (toolUseId, isError, output)
- `ProgressEvent`: Periodic heartbeat (elapsed seconds)
- `ReadyEvent`: Agent ready at start (sessionId, model, tools)
- `RetryEvent`: API retry event (attempt, delayMs, error)
- `DoneEvent`: Conversation completion (sessionId, usage)
- `ErrorEvent`: Error condition (code, detail, exitCode)
- `RawEvent`: Unknown event type fallback (rawType, rawSubtype, data)

## Configuration

### Binary Resolution

The client resolves the binary in order:

1. `CODE_WRAPPER_BINARY` environment variable
2. `code-wrapper` in PATH
3. Platform-specific binary bundled in the package

```bash
# Use env var to override
export CODE_WRAPPER_BINARY=/path/to/custom/binary

# Or put binary in PATH
export PATH=/my/binaries:$PATH

# Or use bundled binary (default)
```

### Timeouts

```python
options = ClientOptions(
    cwd="/workspace",
    prompt="test",
    idle_timeout=300,      # stdout silence (seconds)
    max_timeout=3600,      # hard wall-clock ceiling
)
```

## Session Management

Session persistence is **delegated to the binary** — the Python client only tracks session IDs in memory. The binary manages persistence via the `--session-dir` flag.

```python
from code_wrapper import SessionTracker, CodeWrapper, ClientOptions

tracker = SessionTracker()

# On first turn, get_run_kwargs returns {"is_first_message": True}
# On subsequent turns, it returns {"session_id": "...", "is_first_message": False}
session_kwargs = tracker.get_run_kwargs("user-123")

options = ClientOptions(
    cwd="/workspace",
    prompt="user message",
    session_dir="/tmp/sessions",      # Binary persists here
    recover_stale_session=True,       # Auto-recover from stale sessions
    **session_kwargs,
)

client = CodeWrapper()
async for event in client.run(options):
    if event.type == "done":
        tracker.record_done("user-123", event.sessionId)  # Record for next turn
    elif event.type == "error" and event.code == "stale_session":
        tracker.clear("user-123")     # Clear on stale_session error

# For applications with custom persistence (Redis, database):
# Skip the tracker and manage session_id/is_first_message yourself
```

## Client Options

```python
options = ClientOptions(
    cwd="/workspace",                      # Working directory (required)
    prompt="test",                         # Prompt text (required)
    session_id="sess-123",                 # Resume this session (optional)
    is_first_message=True,                 # --session-id vs --resume (default: True)
    session_dir="/path/to/sessions",       # Binary's session persistence directory
    recover_stale_session=True,            # Auto-recover from stale sessions
    idle_timeout=300,                      # stdout silence ceiling (s)
    max_timeout=3600,                      # hard wall-clock ceiling (s)
    skip_permissions=False,                # bypass permission checks
    agent="my-agent",                      # use a specific agent
    mcp_config_path="/path/to/config.json",  # MCP configuration (Claude only)
    backend="claude",                      # "claude", "copilot", or "antigravity"
)
```

## Subprocess Management

On cancellation/timeout, the client:
1. Sends SIGTERM to the process group
2. Waits 3 seconds for graceful shutdown
3. Escalates to SIGKILL if needed

The `CLAUDECODE` environment variable is automatically deleted before spawning to prevent nested session refusal.

## Exit Codes

The binary exits with:
- `0`: Clean completion
- `2`: Unexpected error during execution (yields `ErrorEvent { code: 'internal_error' }`)
- `3`: Reserved for protocol errors (may be raised as `CodeWrapperProtocolError`)

## Testing

```bash
pip install ".[dev]"
pytest tests/
```

## Regenerating Models

`src/code_wrapper/models.py` is generated from `schemas/claude-event.v1.schema.json`
(itself generated from the TypeScript types in the main package). Regenerate it
locally whenever you change either of those:

```bash
pip install -e ".[codegen]"
python scripts/generate_models.py
```

The `codegen` extra pins every package that can affect the generated bytes
(`datamodel-code-generator`, `black`, `isort`, `Jinja2`, `inflect`) to exact
versions, so your local run and CI's verification produce identical output.
CI only *checks* that `models.py` matches what this command produces for the
current schema — it never generates or commits models itself, and it only
runs that check when the schema, the generator script, or `models.py` have
actually changed. If CI fails with a drift error, run the command above and
commit the result.

## Type Hints

All event types are fully typed with Pydantic BaseModel, supporting IDE autocomplete and type checking:

```python
async for event in client.run(options):
    if event.type == "text":
        # Type checker knows this is TextEvent
        print(event.text)
    elif event.type == "error":
        # Type checker knows this is ErrorEvent
        print(f"Error: {event.code} - {event.detail}")
```
