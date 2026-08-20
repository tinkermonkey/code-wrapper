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
from code_wrapper import CodeWrapper, ClientOptions, SessionManager, DoneEvent

async def chat(user_id: str, prompt: str):
    sessions = SessionManager(persist_path="./sessions.json")
    
    # Resume or create new session
    session = sessions.resume_session(user_id) or sessions.new_session(user_id)
    
    options = ClientOptions(
        cwd="/workspace",
        prompt=prompt,
        session_id=session.cliSessionId,
        is_first_message=session.isFirst,
    )
    
    client = CodeWrapper()
    async for event in client.run(options):
        if event.type == "done":
            # Persist the session ID for next time
            sessions.record_cli_session_id(user_id, event.sessionId)
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

Sessions are persisted to disk and can be resumed across runs:

```python
manager = SessionManager(persist_path="./sessions.json")

# New session
session = manager.new_session("user-123")

# Resume if it exists
session = manager.resume_session("user-123")
if not session:
    session = manager.new_session("user-123")

# Record the CLI-assigned session ID after a successful run
manager.record_cli_session_id("user-123", done_event.sessionId)

# Clear a stale session (e.g., on stale_session error)
manager.clear_session("user-123")

# List all sessions
sessions = manager.list_sessions()

# Namespace isolation for multi-tenant scenarios
manager = SessionManager(
    persist_path="./sessions.json",
    namespace="app-name"
)
```

## Client Options

```python
options = ClientOptions(
    cwd="/workspace",              # Working directory
    prompt="test",                 # Prompt text
    session_id="sess-123",         # Resume this session
    is_first_message=True,         # --session-id vs --resume
    idle_timeout=300,              # stdout silence ceiling (s)
    max_timeout=3600,              # hard wall-clock ceiling (s)
    skip_permissions=False,        # bypass permission checks
    agent="my-agent",              # use a specific agent
    mcp_config_path="/path/to/config.json",  # MCP configuration
    backend="claude",              # "claude" or "copilot"
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
