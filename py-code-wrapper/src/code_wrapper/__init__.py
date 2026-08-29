"""py-code-wrapper: Python async client for code-wrapper binary.

A thin wrapper that spawns the compiled code-wrapper binary and exposes
an async generator over its NDJSON output. The client contains zero protocol
knowledge — it only resolves the binary, manages the subprocess, and
deserializes JSON lines into hand-written type models.

Example:
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

For session resumption (with binary-managed persistence):
    from code_wrapper import CodeWrapper, ClientOptions, SessionTracker

    tracker = SessionTracker()
    session_kwargs = tracker.get_run_kwargs("user-123")

    options = ClientOptions(
        cwd="/workspace",
        prompt="Continue from before",
        session_dir="./sessions",
        recover_stale_session=True,
        **session_kwargs
    )

    client = CodeWrapper()
    async for event in client.run(options):
        if event.type == "done":
            tracker.record_done("user-123", event.sessionId)
"""

__version__ = "0.1.0"

# Public API
from ._binary import (
    CodeWrapperBinaryError,
    resolve_binary,
)
from .client import (
    ClientOptions,
    CodeWrapper,
    CodeWrapperProtocolError,
    run,
)
from .models import (
    BaseEvent,
    ClaudeEvent,
    DoneEvent,
    ErrorEvent,
    ProgressEvent,
    RawEvent,
    ReadyEvent,
    RetryEvent,
    TextEvent,
    ThinkingEvent,
    ToolResultEvent,
    ToolUseEvent,
    Usage,
    deserialize_event,
)
from .sessions import SessionTracker

__all__ = [
    "BaseEvent",
    # Models
    "ClaudeEvent",
    "ClientOptions",
    # Client
    "CodeWrapper",
    "CodeWrapperBinaryError",
    "CodeWrapperProtocolError",
    "DoneEvent",
    "ErrorEvent",
    "ProgressEvent",
    "RawEvent",
    "ReadyEvent",
    "RetryEvent",
    # Sessions
    "SessionTracker",
    "TextEvent",
    "ThinkingEvent",
    "ToolResultEvent",
    "ToolUseEvent",
    "Usage",
    "deserialize_event",
    # Binary
    "resolve_binary",
    "run",
]
