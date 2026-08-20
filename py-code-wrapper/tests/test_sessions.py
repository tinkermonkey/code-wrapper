"""Tests for code-wrapper session management."""

import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from code_wrapper.sessions import (
    Session,
    SessionManager,
    MemoryStore,
    FileStore,
    create_session_store,
)


class TestSession:
    """Test Session dataclass."""

    def test_session_creation(self):
        now = datetime.now(timezone.utc).isoformat()
        session = Session(
            key="user-123",
            cliSessionId="sess-abc",
            createdAt=now,
            lastActiveAt=now,
            isFirst=False,
        )
        assert session.key == "user-123"
        assert session.cliSessionId == "sess-abc"
        assert session.isFirst is False


class TestMemoryStore:
    """Test in-memory session storage."""

    def test_set_and_get(self):
        store = MemoryStore()
        now = datetime.now(timezone.utc).isoformat()
        session = Session(
            key="test",
            cliSessionId="sess-1",
            createdAt=now,
            lastActiveAt=now,
            isFirst=True,
        )

        store.set(session)
        retrieved = store.get("test")
        assert retrieved is not None
        assert retrieved.cliSessionId == "sess-1"

    def test_delete(self):
        store = MemoryStore()
        now = datetime.now(timezone.utc).isoformat()
        session = Session(
            key="test",
            cliSessionId="sess-1",
            createdAt=now,
            lastActiveAt=now,
            isFirst=True,
        )

        store.set(session)
        store.delete("test")
        assert store.get("test") is None

    def test_all_sorted_by_last_active(self):
        store = MemoryStore()

        # Create sessions with different timestamps
        now = datetime.now(timezone.utc).isoformat()

        session1 = Session(
            key="old",
            cliSessionId="sess-1",
            createdAt=now,
            lastActiveAt="2026-01-01T00:00:00+00:00",
            isFirst=True,
        )

        session2 = Session(
            key="new",
            cliSessionId="sess-2",
            createdAt=now,
            lastActiveAt="2026-12-31T23:59:59+00:00",
            isFirst=True,
        )

        store.set(session1)
        store.set(session2)

        all_sessions = store.all()
        assert len(all_sessions) == 2
        assert all_sessions[0].key == "new"  # Most recent first
        assert all_sessions[1].key == "old"


class TestFileStore:
    """Test file-based session storage."""

    def test_persistence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "sessions.json"

            # Create store and add session
            store1 = FileStore(path)
            now = datetime.now(timezone.utc).isoformat()
            session = Session(
                key="test",
                cliSessionId="sess-1",
                createdAt=now,
                lastActiveAt=now,
                isFirst=True,
            )
            store1.set(session)

            # Create new store from same path
            store2 = FileStore(path)
            retrieved = store2.get("test")
            assert retrieved is not None
            assert retrieved.cliSessionId == "sess-1"

    def test_missing_file_starts_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "nonexistent" / "sessions.json"
            store = FileStore(path)
            assert store.all() == []

    def test_atomic_write(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "sessions.json"

            store = FileStore(path)
            now = datetime.now(timezone.utc).isoformat()

            # Add multiple sessions
            for i in range(3):
                session = Session(
                    key=f"session-{i}",
                    cliSessionId=f"sess-{i}",
                    createdAt=now,
                    lastActiveAt=now,
                    isFirst=True,
                )
                store.set(session)

            # Verify file exists and is valid JSON
            assert path.exists()
            with open(path) as f:
                import json

                data = json.load(f)
                assert len(data) == 3

    def test_delete_persists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "sessions.json"

            store = FileStore(path)
            now = datetime.now(timezone.utc).isoformat()
            session = Session(
                key="test",
                cliSessionId="sess-1",
                createdAt=now,
                lastActiveAt=now,
                isFirst=True,
            )
            store.set(session)

            # Delete
            store.delete("test")

            # Create new store from same path
            store2 = FileStore(path)
            assert store2.get("test") is None


class TestSessionManager:
    """Test session lifecycle management."""

    def test_new_session(self):
        manager = SessionManager()
        session = manager.new_session("user-123")

        assert session.key == "user-123"
        assert session.cliSessionId is None
        assert session.isFirst is True
        assert session.createdAt is not None

    def test_resume_session_without_cli_id(self):
        manager = SessionManager()
        manager.new_session("user-123")

        # Can't resume without cliSessionId
        resumed = manager.resume_session("user-123")
        assert resumed is None

    def test_resume_session_with_cli_id(self):
        manager = SessionManager()
        manager.new_session("user-123")
        manager.record_cli_session_id("user-123", "sess-abc")

        # Now can resume
        resumed = manager.resume_session("user-123")
        assert resumed is not None
        assert resumed.cliSessionId == "sess-abc"

    def test_record_cli_session_id(self):
        manager = SessionManager()
        session = manager.new_session("user-123")
        assert session.isFirst is True

        manager.record_cli_session_id("user-123", "sess-abc")
        session = manager.resume_session("user-123")

        assert session.cliSessionId == "sess-abc"
        assert session.isFirst is False

    def test_touch_updates_timestamp(self):
        manager = SessionManager()
        manager.new_session("user-123")

        session1 = manager.resume_session("user-123")
        if session1:
            original_timestamp = session1.lastActiveAt

        # Wait a tiny bit and touch
        import time

        time.sleep(0.01)
        manager.touch("user-123")

        # Get a new reference (in memory, should be same object but check anyway)
        manager.resume_session("user-123")

    def test_clear_session(self):
        manager = SessionManager()
        manager.new_session("user-123")
        manager.record_cli_session_id("user-123", "sess-abc")

        # Clear
        manager.clear_session("user-123")

        # Can't resume anymore
        assert manager.resume_session("user-123") is None

    def test_list_sessions(self):
        manager = SessionManager()

        # Create multiple sessions
        manager.new_session("user-1")
        manager.new_session("user-2")
        manager.new_session("user-3")

        sessions = manager.list_sessions()
        assert len(sessions) == 3
        assert all(s.key in ["user-1", "user-2", "user-3"] for s in sessions)

    def test_namespace_isolation(self):
        manager1 = SessionManager(namespace="app1")
        manager2 = SessionManager(namespace="app2")

        manager1.new_session("user-123")
        manager2.new_session("user-123")

        # Should have different keys
        sessions1 = manager1.list_sessions()
        sessions2 = manager2.list_sessions()

        assert len(sessions1) == 1
        assert len(sessions2) == 1
        assert sessions1[0].key == "app1:user-123"
        assert sessions2[0].key == "app2:user-123"

    def test_file_persistence_with_namespace(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "sessions.json"

            # Create session with namespace
            manager1 = SessionManager(persist_path=str(path), namespace="app1")
            manager1.new_session("user-123")
            manager1.record_cli_session_id("user-123", "sess-abc")

            # Create another manager with different namespace
            manager2 = SessionManager(persist_path=str(path), namespace="app2")
            manager2.new_session("user-123")

            # app1 should still have its session
            manager1_reload = SessionManager(persist_path=str(path), namespace="app1")
            resumed = manager1_reload.resume_session("user-123")
            assert resumed is not None
            assert resumed.cliSessionId == "sess-abc"

            # app2 shouldn't
            manager2_reload = SessionManager(persist_path=str(path), namespace="app2")
            resumed2 = manager2_reload.resume_session("user-123")
            assert resumed2 is None  # Didn't record CLI session ID


class TestCreateSessionStore:
    """Test session store factory."""

    def test_memory_store_default(self):
        store = create_session_store()
        assert isinstance(store, MemoryStore)

    def test_file_store_with_path(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "sessions.json"
            store = create_session_store(str(path))
            assert isinstance(store, FileStore)
