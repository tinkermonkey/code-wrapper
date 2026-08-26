"""Tests for the Python code-wrapper client."""

import asyncio
import json
import os
import signal
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from code_wrapper import ClientOptions, CodeWrapper, CodeWrapperProtocolError


def create_mock_process():
    """Create a properly configured mock process."""
    mock_process = AsyncMock()
    mock_process.returncode = None
    # Real int, guaranteed not to belong to any process on the host: an
    # unconfigured AsyncMock attribute would otherwise coerce to 1 via
    # __index__, and CodeWrapper._cleanup_process()'s real (unmocked)
    # os.getpgid/os.killpg calls would then signal process group 1 --
    # i.e. the whole surrounding container -- when the test's async
    # generator is torn down. See client.py's _signal_process_group guard.
    mock_process.pid = 999999999
    mock_stdin = AsyncMock()
    mock_stdin.write = MagicMock()
    mock_stdin.drain = AsyncMock()
    mock_stdin.close = MagicMock()
    mock_process.stdin = mock_stdin
    mock_process.stdout = AsyncMock()
    mock_process.wait = AsyncMock()
    mock_process.kill = MagicMock()
    mock_process.terminate = MagicMock()
    return mock_process


@pytest.fixture
def client():
    """Create a client instance."""
    return CodeWrapper()


@pytest.fixture
def basic_options():
    """Create basic client options."""
    return ClientOptions(
        cwd="/tmp",
        prompt="test prompt",
    )


class TestClientOptions:
    """Test ClientOptions creation."""

    def test_basic_creation(self):
        opts = ClientOptions(cwd="/test", prompt="hello")
        assert opts.cwd == "/test"
        assert opts.prompt == "hello"
        assert opts.is_first_message is True
        assert opts.idle_timeout == 300
        assert opts.skip_permissions is False

    def test_with_session(self):
        opts = ClientOptions(
            cwd="/test",
            prompt="hello",
            session_id="sess-123",
            is_first_message=False,
        )
        assert opts.session_id == "sess-123"
        assert opts.is_first_message is False


class TestProtocolVersionCheck:
    """Test wire protocol version checking."""

    @pytest.mark.asyncio
    async def test_version_mismatch_raises_error(self, client, basic_options):
        """Should raise CodeWrapperProtocolError on version mismatch."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()

                # First line has wrong version
                mock_process.stdout.readline = AsyncMock(
                    side_effect=[
                        b'{"v": 2, "seq": 0, "timestamp": 0, "type": "ready"}\n',
                        b"",
                    ]
                )

                mock_subprocess.return_value = mock_process

                with pytest.raises(CodeWrapperProtocolError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                assert "version mismatch" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_version_check_on_first_event(self, client, basic_options):
        """Should check version only on first event."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                # Create mock process
                mock_process = create_mock_process()

                # Valid version
                ready_event = {"v": 1, "seq": 0, "timestamp": 0, "type": "ready", "sessionId": "s1"}
                mock_process.stdout.readline = AsyncMock(
                    side_effect=[
                        json.dumps(ready_event).encode() + b"\n",
                        b"",
                    ]
                )

                mock_subprocess.return_value = mock_process

                events = []
                async for event in client.run(basic_options):
                    events.append(event)

                assert len(events) >= 1
                assert events[0].type == "ready"


class TestJsonParsing:
    """Test JSON parsing and error handling."""

    @pytest.mark.asyncio
    async def test_invalid_json_yields_error_event(self, client, basic_options):
        """Should yield error event for invalid JSON."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()

                # Invalid JSON line
                mock_process.stdout.readline = AsyncMock(
                    side_effect=[
                        b'{"v": 1, "seq": 0, "type": "text", "text": "hello"\n',  # Missing }
                        b"",
                    ]
                )

                mock_subprocess.return_value = mock_process

                events = []
                async for event in client.run(basic_options):
                    events.append(event)

                # Should have an error event
                error_events = [e for e in events if e.type == "error"]
                assert len(error_events) > 0
                assert error_events[0].code == "parse_error"

    @pytest.mark.asyncio
    async def test_unknown_event_type_becomes_raw_event(self, client, basic_options):
        """Should wrap unknown event types as RawEvent."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()

                # Unknown type
                mock_process.stdout.readline = AsyncMock(
                    side_effect=[
                        b'{"v": 1, "seq": 0, "timestamp": 0, "type": "unknown_future_type", "data": {}}\n',
                        b"",
                    ]
                )

                mock_subprocess.return_value = mock_process

                events = []
                async for event in client.run(basic_options):
                    events.append(event)

                assert len(events) > 0
                assert events[0].type == "raw"
                assert events[0].rawType == "unknown_future_type"


class TestBinaryOptions:
    """Test binary argument construction."""

    @pytest.mark.asyncio
    async def test_session_id_first_message(self, client, basic_options):
        """Should use --session-id for first message."""
        basic_options.session_id = "sess-123"
        basic_options.is_first_message = True

        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                async for _ in client.run(basic_options):
                    pass

                # Check that --session-id was used
                call_args = mock_subprocess.call_args
                assert "--session-id" in call_args[0]

    @pytest.mark.asyncio
    async def test_resume_second_message(self, client, basic_options):
        """Should use --resume for non-first message."""
        basic_options.session_id = "sess-123"
        basic_options.is_first_message = False

        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                async for _ in client.run(basic_options):
                    pass

                # Check that --resume was used
                call_args = mock_subprocess.call_args
                assert "--resume" in call_args[0]


class TestClaudeCodeEnvDeletion:
    """Test that CLAUDECODE env var is deleted."""

    @pytest.mark.asyncio
    async def test_claudecode_env_deleted(self, client, basic_options):
        """Should delete CLAUDECODE env var before spawning."""
        os.environ["CLAUDECODE"] = "test-value"

        try:
            with patch("code_wrapper.client.resolve_binary") as mock_resolve:
                mock_binary = MagicMock()
                mock_resolve.return_value = mock_binary

                with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                    mock_process = create_mock_process()
                    mock_process.stdout.readline = AsyncMock(return_value=b"")

                    mock_subprocess.return_value = mock_process

                    async for _ in client.run(basic_options):
                        pass

                    # Check that CLAUDECODE was not in env
                    call_kwargs = mock_subprocess.call_args[1]
                    passed_env = call_kwargs.get("env", {})
                    assert "CLAUDECODE" not in passed_env

        finally:
            del os.environ["CLAUDECODE"]


class TestCleanupProcessGuards:
    """Test that _cleanup_process never signals a bogus or unrelated process group.

    Regression coverage for a bug where an unconfigured mock's `.pid`
    (a non-integer) was silently coerced by os.getpgid()/os.killpg() via
    the __index__ protocol, resolving to process group 1 and sending a
    real SIGTERM to the surrounding container. See client.py's
    _signal_process_group.

    All pid/pgid values used here are inert sentinels -- os.getpgid and
    os.killpg are always patched, so no test depends on a real process
    existing at these values.
    """

    @pytest.mark.asyncio
    async def test_cleanup_skips_non_integer_pid(self, client):
        """A non-integer pid must never reach os.getpgid/os.killpg."""
        client._process = create_mock_process()
        client._process.pid = AsyncMock()  # not a real int, e.g. an unconfigured mock

        with patch("code_wrapper.client.os.getpgid") as mock_getpgid:
            with patch("code_wrapper.client.os.killpg") as mock_killpg:
                await client._cleanup_process()

        mock_getpgid.assert_not_called()
        mock_killpg.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_skips_bool_pid(self, client):
        """bool is an int subclass -- True/False must still be rejected."""
        client._process = create_mock_process()
        client._process.pid = True

        with patch("code_wrapper.client.os.getpgid") as mock_getpgid:
            with patch("code_wrapper.client.os.killpg") as mock_killpg:
                await client._cleanup_process()

        mock_getpgid.assert_not_called()
        mock_killpg.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_skips_non_positive_pid(self, client):
        """A pid <= 0 is never a real spawned child."""
        client._process = create_mock_process()
        client._process.pid = 0

        with patch("code_wrapper.client.os.getpgid") as mock_getpgid:
            with patch("code_wrapper.client.os.killpg") as mock_killpg:
                await client._cleanup_process()

        mock_getpgid.assert_not_called()
        mock_killpg.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_skips_pgid_pid_mismatch(self, client):
        """A resolved pgid that doesn't match the pid means this isn't our
        spawned child -- a legitimate child is always its own group leader
        via _preexec_fn's os.setpgrp(). This must be rejected even though
        the pgid resolves successfully and doesn't happen to equal our own
        group (the case a weaker "not our own group" check would miss)."""
        client._process = create_mock_process()
        client._process.pid = 424242  # inert sentinel; getpgid is stubbed below

        with patch("code_wrapper.client.os.getpgid", return_value=999999):  # != pid
            with patch("code_wrapper.client.os.killpg") as mock_killpg:
                await client._cleanup_process()

        mock_killpg.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_signals_valid_child_pgid(self, client):
        """A real child, its own process group leader, is signaled normally."""
        client._process = create_mock_process()
        client._process.pid = 424242  # inert sentinel; getpgid is stubbed below
        client._process.wait = AsyncMock(return_value=0)

        with patch("code_wrapper.client.os.getpgid", return_value=424242):  # == pid
            with patch("code_wrapper.client.os.killpg") as mock_killpg:
                await client._cleanup_process()

        mock_killpg.assert_called_once_with(424242, signal.SIGTERM)

    @pytest.mark.asyncio
    async def test_cleanup_escalates_to_sigkill_on_timeout(self, client):
        """If the process doesn't exit within 3s of SIGTERM, escalate to
        SIGKILL on the same process group."""
        client._process = create_mock_process()
        client._process.pid = 424242  # inert sentinel; getpgid is stubbed below
        client._process.wait = AsyncMock(side_effect=[asyncio.TimeoutError(), None])

        with patch("code_wrapper.client.os.getpgid", return_value=424242):  # == pid
            with patch("code_wrapper.client.os.killpg") as mock_killpg:
                await client._cleanup_process()

        assert mock_killpg.call_args_list == [
            call(424242, signal.SIGTERM),
            call(424242, signal.SIGKILL),
        ]
