"""Session management for code-wrapper client.

Persists sessions to disk (or memory) and provides resumption across runs.
Delegates to the binary's session manager — Python does not re-implement persistence.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass
class Session:
    """A persisted session that can be resumed.

    Attributes:
        key: App-defined key (CallSid, userId, path, task_id, …)
        cliSessionId: Session ID assigned by the CLI
        createdAt: ISO 8601 creation timestamp
        lastActiveAt: ISO 8601 last activity timestamp
        isFirst: True until the first message completes and cliSessionId is recorded
    """

    key: str
    cliSessionId: str | None
    createdAt: str
    lastActiveAt: str
    isFirst: bool


class ISessionStore:
    """Abstract session storage interface."""

    def get(self, key: str) -> Session | None:
        """Get a session by key."""
        raise NotImplementedError

    def set(self, session: Session) -> None:
        """Store or update a session."""
        raise NotImplementedError

    def delete(self, key: str) -> None:
        """Delete a session."""
        raise NotImplementedError

    def all(self) -> list[Session]:
        """Get all sessions, sorted by lastActiveAt descending."""
        raise NotImplementedError


class MemoryStore(ISessionStore):
    """In-memory session storage."""

    def __init__(self):
        self._sessions: dict[str, Session] = {}

    def get(self, key: str) -> Session | None:
        return self._sessions.get(key)

    def set(self, session: Session) -> None:
        self._sessions[session.key] = session

    def delete(self, key: str) -> None:
        self._sessions.pop(key, None)

    def all(self) -> list[Session]:
        return sorted(self._sessions.values(), key=lambda s: s.lastActiveAt, reverse=True)


class FileStore(ISessionStore):
    """File-based session storage with atomic writes."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._sessions: dict[str, Session] = {}
        self._load()

    def _load(self) -> None:
        """Load sessions from disk, silently starting empty if missing."""
        if not self.path.exists():
            return

        try:
            with open(self.path, "r") as f:
                data = json.load(f)
                for session_dict in data:
                    session = Session(**session_dict)
                    self._sessions[session.key] = session
        except (json.JSONDecodeError, OSError, KeyError):
            # Silent fail: start empty
            pass

    def _flush(self) -> None:
        """Write sessions to disk atomically using tmp + rename."""
        self.path.parent.mkdir(parents=True, exist_ok=True)

        # Write to temp file
        tmp_path = self.path.with_suffix(".tmp")
        try:
            with open(tmp_path, "w") as f:
                sessions_list = [asdict(s) for s in self._sessions.values()]
                json.dump(sessions_list, f, indent=2)

            # Atomic rename
            tmp_path.replace(self.path)
        except OSError as e:
            if tmp_path.exists():
                tmp_path.unlink()
            raise RuntimeError(f"Failed to flush session store: {e}") from e

    def get(self, key: str) -> Session | None:
        return self._sessions.get(key)

    def set(self, session: Session) -> None:
        self._sessions[session.key] = session
        self._flush()

    def delete(self, key: str) -> None:
        if key in self._sessions:
            del self._sessions[key]
            self._flush()

    def all(self) -> list[Session]:
        return sorted(self._sessions.values(), key=lambda s: s.lastActiveAt, reverse=True)


def create_session_store(persist_path: str | None = None) -> ISessionStore:
    """Create a session store (file-based or in-memory).

    Args:
        persist_path: Path to file for persistence. If None, returns MemoryStore.

    Returns:
        An ISessionStore instance.
    """
    if persist_path:
        return FileStore(Path(persist_path))
    return MemoryStore()


class SessionManager:
    """Manages session lifecycle across runs.

    Persists sessions to disk and provides resumption. Does not re-implement
    the binary's session storage — it only tracks the CLI-assigned session IDs
    that are returned in ReadyEvent and DoneEvent.
    """

    def __init__(
        self,
        persist_path: str | None = None,
        namespace: str | None = None,
    ):
        """Initialize the session manager.

        Args:
            persist_path: Path to file for persistence. If None, uses in-memory storage.
            namespace: Key prefix to isolate multiple managers in one file.
        """
        self._store = create_session_store(persist_path)
        self._namespace = namespace or ""

    def _make_key(self, key: str) -> str:
        """Apply namespace prefix to a key."""
        if self._namespace:
            return f"{self._namespace}:{key}"
        return key

    def new_session(self, key: str) -> Session:
        """Create a new session.

        Args:
            key: App-defined session key.

        Returns:
            A new Session with isFirst=True.
        """
        now = datetime.now(timezone.utc).isoformat()
        session = Session(
            key=self._make_key(key),
            cliSessionId=None,
            createdAt=now,
            lastActiveAt=now,
            isFirst=True,
        )
        self._store.set(session)
        return session

    def resume_session(self, key: str) -> Session | None:
        """Resume an existing session.

        Args:
            key: App-defined session key.

        Returns:
            The Session if it exists and has a cliSessionId, else None.
        """
        session = self._store.get(self._make_key(key))
        if session and session.cliSessionId:
            self.touch(key)
            return session
        return None

    def list_sessions(self) -> list[Session]:
        """List all sessions in this namespace, sorted by lastActiveAt descending.

        Returns:
            List of Session objects.
        """
        prefix = f"{self._namespace}:" if self._namespace else ""
        all_sessions = self._store.all()
        if self._namespace:
            return [s for s in all_sessions if s.key.startswith(prefix)]
        return all_sessions

    def record_cli_session_id(self, key: str, cli_session_id: str) -> None:
        """Record the CLI-assigned session ID when a run completes.

        Call this after receiving a DoneEvent to persist the session ID
        for future resumption.

        Args:
            key: App-defined session key.
            cli_session_id: Session ID from the binary's DoneEvent.
        """
        session = self._store.get(self._make_key(key))
        if session:
            session.cliSessionId = cli_session_id
            session.isFirst = False
            self.touch(key)

    def touch(self, key: str) -> None:
        """Update the lastActiveAt timestamp for a session.

        Args:
            key: App-defined session key.
        """
        session = self._store.get(self._make_key(key))
        if session:
            session.lastActiveAt = datetime.now(timezone.utc).isoformat()
            self._store.set(session)

    def clear_session(self, key: str) -> None:
        """Delete a session (e.g., on stale_session error).

        Args:
            key: App-defined session key.
        """
        self._store.delete(self._make_key(key))
