"""Tests for code-wrapper session tracking."""

from code_wrapper.sessions import SessionTracker


class TestSessionTracker:
    """Test in-memory session tracking."""

    def test_initialization(self):
        tracker = SessionTracker()
        assert tracker.get_run_kwargs("any-key") == {"is_first_message": True}

    def test_get_run_kwargs_first_message(self):
        tracker = SessionTracker()
        kwargs = tracker.get_run_kwargs("user-123")
        assert kwargs == {"is_first_message": True}

    def test_get_run_kwargs_with_session_id(self):
        tracker = SessionTracker()
        tracker.record_done("user-123", "sess-abc")

        kwargs = tracker.get_run_kwargs("user-123")
        assert kwargs == {"session_id": "sess-abc", "is_first_message": False}

    def test_record_done_tracks_session_id(self):
        tracker = SessionTracker()
        tracker.record_done("user-123", "sess-abc")

        kwargs = tracker.get_run_kwargs("user-123")
        assert kwargs["session_id"] == "sess-abc"
        assert kwargs["is_first_message"] is False

    def test_record_done_overwrites_previous(self):
        tracker = SessionTracker()
        tracker.record_done("user-123", "sess-abc")
        tracker.record_done("user-123", "sess-def")

        kwargs = tracker.get_run_kwargs("user-123")
        assert kwargs["session_id"] == "sess-def"

    def test_clear_removes_session(self):
        tracker = SessionTracker()
        tracker.record_done("user-123", "sess-abc")
        tracker.clear("user-123")

        kwargs = tracker.get_run_kwargs("user-123")
        assert kwargs == {"is_first_message": True}

    def test_clear_nonexistent_session(self):
        tracker = SessionTracker()
        # Should not raise
        tracker.clear("nonexistent")
        assert tracker.get_run_kwargs("nonexistent") == {"is_first_message": True}

    def test_multiple_sessions(self):
        tracker = SessionTracker()
        tracker.record_done("user-1", "sess-1")
        tracker.record_done("user-2", "sess-2")
        tracker.record_done("user-3", "sess-3")

        assert tracker.get_run_kwargs("user-1")["session_id"] == "sess-1"
        assert tracker.get_run_kwargs("user-2")["session_id"] == "sess-2"
        assert tracker.get_run_kwargs("user-3")["session_id"] == "sess-3"

    def test_independent_keys(self):
        tracker = SessionTracker()
        tracker.record_done("app-a:user-123", "sess-a")

        # Clear only affects the specific key
        tracker.clear("app-b:user-456")

        kwargs = tracker.get_run_kwargs("app-a:user-123")
        assert kwargs["session_id"] == "sess-a"
