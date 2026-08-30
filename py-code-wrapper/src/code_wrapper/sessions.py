"""Session tracking for code-wrapper client.

Provides minimal in-memory tracking of session IDs. Session persistence
is delegated to the binary's session manager via --session-dir flag.
The Python client only extracts and tracks session IDs from events.
"""

from __future__ import annotations

from typing import TypedDict

from .client import ClientOptions, CodeWrapper


class _RunKwargs(TypedDict, total=False):
    """Type-safe dict for session-related kwargs passed to run()."""

    session_id: str
    is_first_message: bool


class SessionTracker:
    """Minimal in-memory tracker for session IDs.

    Does NOT implement session persistence. The binary handles persistence
    via --session-dir flag. This class only tracks:
    - Which session IDs have been seen (from DoneEvent/ReadyEvent)
    - Whether a session is first-message or resumed
    - Application-defined keys mapped to session IDs

    For applications with their own persistence (Redis, database, etc.),
    skip this class and pass session_id/is_first_message directly to run().
    """

    def __init__(self, session_dir: str | None = None):
        """Initialize an empty session tracker.

        Args:
            session_dir: Optional path to session persistence directory.
                         If provided, enables inspect() method.
        """
        self._sessions: dict[str, str] = {}  # key -> cli_session_id
        self._first: dict[str, bool] = {}  # key -> is_first
        self._session_dir = session_dir

    def get_run_kwargs(self, key: str) -> _RunKwargs:
        """Get session_id and is_first_message for a run() call.

        Args:
            key: App-defined session key.

        Returns:
            A dict with session_id and is_first_message suitable for
            unpacking into run()'s kwargs.
        """
        session_id = self._sessions.get(key)
        is_first = self._first.get(key, True)
        kwargs: _RunKwargs = {"is_first_message": is_first}
        if session_id:
            kwargs["session_id"] = session_id
        return kwargs

    def record_done(self, key: str, session_id: str) -> None:
        """Record a session ID from a DoneEvent.

        Call this after receiving a DoneEvent to track the session ID
        for future resumption.

        Args:
            key: App-defined session key.
            session_id: Session ID from the binary's DoneEvent.
        """
        self._sessions[key] = session_id
        self._first[key] = False

    def clear(self, key: str) -> None:
        """Clear a session (e.g., on stale_session error).

        Args:
            key: App-defined session key.
        """
        self._sessions.pop(key, None)
        self._first.pop(key, None)

    async def inspect(
        self,
        session_id: str,
        cwd: str = "/workspace",
        backend: str = "claude",
    ) -> dict | None:
        """Inspect a session without running a full generation.

        Queries the binary for session metadata (createdAt, lastActiveAt, cliSessionId).
        Requires session_dir to have been provided during initialization.

        Args:
            session_id: The session ID to inspect.
            cwd: Working directory (default: /workspace).
            backend: Backend to use (default: claude).

        Returns:
            A dict with keys: sessionId, createdAt, lastActiveAt, cliSessionId.
            Returns None if session not found.

        Raises:
            ValueError: If session_dir was not provided during initialization.
        """
        if not self._session_dir:
            raise ValueError("inspect() requires session_dir to be provided during initialization")

        options = ClientOptions(
            cwd=cwd,
            prompt="",
            session_dir=self._session_dir,
            backend=backend,
            inspect=session_id,
        )

        client = CodeWrapper()
        async for event in client.run(options):
            if event.type == "ready":
                return {
                    "sessionId": event.sessionId,
                    "createdAt": getattr(event, "createdAt", None),
                    "lastActiveAt": getattr(event, "lastActiveAt", None),
                    "cliSessionId": getattr(event, "cliSessionId", None),
                }
            elif event.type == "error":
                return None

        return None
