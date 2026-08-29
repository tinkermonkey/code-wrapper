"""Tests for code-wrapper session tracking."""

from unittest.mock import MagicMock, patch

import pytest

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


class TestSessionTrackerInspect:
    """Test session inspect operation."""

    @pytest.mark.asyncio
    async def test_inspect_requires_session_dir(self):
        """inspect() should raise ValueError if session_dir was not provided."""
        tracker = SessionTracker()  # No session_dir
        with pytest.raises(ValueError) as exc_info:
            await tracker.inspect("sess-123")
        assert "session_dir" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_inspect_returns_metadata_on_ready_event(self):
        """inspect() should return session metadata from ReadyEvent."""
        tracker = SessionTracker(session_dir="/tmp/sessions")

        with patch("code_wrapper.sessions.CodeWrapper") as mock_wrapper_class:
            mock_client = MagicMock()
            mock_wrapper_class.return_value = mock_client

            # Mock a ready event with session metadata
            ready_event = MagicMock()
            ready_event.type = "ready"
            ready_event.sessionId = "sess-123"
            ready_event.createdAt = "2026-08-29T10:00:00Z"
            ready_event.lastActiveAt = "2026-08-29T10:05:00Z"
            ready_event.cliSessionId = "cli-sess-abc"

            async def async_gen():
                yield ready_event

            mock_client.run.return_value = async_gen()

            result = await tracker.inspect("sess-123")

            assert result is not None
            assert result["sessionId"] == "sess-123"
            assert result["createdAt"] == "2026-08-29T10:00:00Z"
            assert result["lastActiveAt"] == "2026-08-29T10:05:00Z"
            assert result["cliSessionId"] == "cli-sess-abc"

    @pytest.mark.asyncio
    async def test_inspect_returns_none_on_error_event(self):
        """inspect() should return None if an error event is received."""
        tracker = SessionTracker(session_dir="/tmp/sessions")

        with patch("code_wrapper.sessions.CodeWrapper") as mock_wrapper_class:
            mock_client = MagicMock()
            mock_wrapper_class.return_value = mock_client

            # Mock an error event
            error_event = MagicMock()
            error_event.type = "error"
            error_event.code = "session_not_found"

            async def async_gen():
                yield error_event

            mock_client.run.return_value = async_gen()

            result = await tracker.inspect("nonexistent-sess")

            assert result is None

    @pytest.mark.asyncio
    async def test_inspect_returns_none_on_no_events(self):
        """inspect() should return None if no events are yielded."""
        tracker = SessionTracker(session_dir="/tmp/sessions")

        with patch("code_wrapper.sessions.CodeWrapper") as mock_wrapper_class:
            mock_client = MagicMock()
            mock_wrapper_class.return_value = mock_client

            async def async_gen():
                return
                yield  # Make this a generator

            mock_client.run.return_value = async_gen()

            result = await tracker.inspect("sess-123")

            assert result is None

    @pytest.mark.asyncio
    async def test_inspect_uses_provided_cwd_and_backend(self):
        """inspect() should use provided cwd and backend when creating ClientOptions."""
        tracker = SessionTracker(session_dir="/tmp/sessions")

        with (
            patch("code_wrapper.sessions.CodeWrapper") as mock_wrapper_class,
            patch("code_wrapper.sessions.ClientOptions") as mock_options_class,
        ):
            mock_client = MagicMock()
            mock_wrapper_class.return_value = mock_client

            # Mock a ready event
            ready_event = MagicMock()
            ready_event.type = "ready"
            ready_event.sessionId = "sess-123"
            ready_event.createdAt = None
            ready_event.lastActiveAt = None
            ready_event.cliSessionId = None

            async def async_gen():
                yield ready_event

            mock_client.run.return_value = async_gen()

            await tracker.inspect("sess-123", cwd="/custom/cwd", backend="custom-backend")

            # Verify ClientOptions was created with correct params
            mock_options_class.assert_called_once()
            call_kwargs = mock_options_class.call_args[1]
            assert call_kwargs["cwd"] == "/custom/cwd"
            assert call_kwargs["backend"] == "custom-backend"
            assert call_kwargs["session_dir"] == "/tmp/sessions"
            assert call_kwargs["inspect"] == "sess-123"
            assert call_kwargs["prompt"] == ""
