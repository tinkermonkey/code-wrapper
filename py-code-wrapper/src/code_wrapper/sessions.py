"""Session tracking for code-wrapper client.

Provides minimal in-memory tracking of session IDs. Session persistence
is delegated to the binary's session manager via --session-dir flag.
The Python client only extracts and tracks session IDs from events.
"""

from __future__ import annotations

from typing import TypedDict


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

    def __init__(self):
        """Initialize an empty session tracker."""
        self._sessions: dict[str, str] = {}  # key -> cli_session_id
        self._first: dict[str, bool] = {}  # key -> is_first

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
        kwargs = {"is_first_message": is_first}
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
