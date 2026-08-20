"""py-code-wrapper: Python async client for code-wrapper binary.

A thin wrapper that spawns the compiled code-wrapper binary and exposes
an async generator over its NDJSON output. The client contains zero protocol
knowledge — it only resolves the binary, manages the subprocess, and
deserializes JSON lines into generated types.

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

For session resumption:
    from code_wrapper import SessionManager

    sessions = SessionManager(persist_path="./sessions.json")
    session = sessions.resume_session("user-123") or sessions.new_session("user-123")

    options = ClientOptions(
        cwd="/workspace",
        prompt="Continue from before",
        session_id=session.cliSessionId,
        is_first_message=session.isFirst,
    )

    # ... run client ...

    # After receiving DoneEvent
    sessions.record_cli_session_id("user-123", done_event.sessionId)
"""

__version__ = "0.1.0"

# Public API
from .models import (
    ClaudeEvent,
    BaseEvent,
    TextEvent,
    ThinkingEvent,
    ToolUseEvent,
    ToolResultEvent,
    ProgressEvent,
    ReadyEvent,
    RetryEvent,
    DoneEvent,
    ErrorEvent,
    RawEvent,
    Usage,
    deserialize_event,
)
from .client import (
    CodeWrapper,
    ClientOptions,
    run,
    CodeWrapperProtocolError,
)
from ._binary import (
    resolve_binary,
    CodeWrapperBinaryError,
)
from .sessions import (
    Session,
    SessionManager,
    SessionManager as ISessionStore,
    MemoryStore,
    FileStore,
    create_session_store,
)

__all__ = [
    # Models
    "ClaudeEvent",
    "BaseEvent",
    "TextEvent",
    "ThinkingEvent",
    "ToolUseEvent",
    "ToolResultEvent",
    "ProgressEvent",
    "ReadyEvent",
    "RetryEvent",
    "DoneEvent",
    "ErrorEvent",
    "RawEvent",
    "Usage",
    "deserialize_event",
    # Client
    "CodeWrapper",
    "ClientOptions",
    "run",
    "CodeWrapperProtocolError",
    # Binary
    "resolve_binary",
    "CodeWrapperBinaryError",
    # Sessions
    "Session",
    "SessionManager",
    "ISessionStore",
    "MemoryStore",
    "FileStore",
    "create_session_store",
]
