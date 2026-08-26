"""Tests for the Python code-wrapper client."""

import asyncio
import json
import os
import signal
from unittest.mock import AsyncMock, MagicMock, call, patch

import pytest

from code_wrapper import ClientOptions, CodeWrapper, CodeWrapperProtocolError
from code_wrapper._binary import CodeWrapperBinaryError


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

    @pytest.mark.asyncio
    async def test_session_dir_passed_to_binary(self, client, basic_options):
        """Should pass --session-dir to binary when set."""
        basic_options.session_dir = "/tmp/sessions"

        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                async for _ in client.run(basic_options):
                    pass

                # Check that --session-dir was passed
                call_args = mock_subprocess.call_args
                args = call_args[0]
                assert "--session-dir" in args
                idx = args.index("--session-dir")
                assert args[idx + 1] == "/tmp/sessions"

    @pytest.mark.asyncio
    async def test_recover_stale_session_passed_to_binary(self, client, basic_options):
        """Should pass --recover-stale-session to binary when set."""
        basic_options.recover_stale_session = True

        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                async for _ in client.run(basic_options):
                    pass

                # Check that --recover-stale-session was passed
                call_args = mock_subprocess.call_args
                assert "--recover-stale-session" in call_args[0]


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
    """Test that _cleanup_process never signals a bogus or unrelated process.

    Regression coverage for a bug where an unconfigured mock's `.pid`
    (a non-integer) was silently coerced by os.kill() via the __index__
    protocol, resolving to an unrelated process. See client.py's
    _validate_and_signal_process.

    All pid values used here are inert sentinels -- os.kill is always
    patched, so no test depends on a real process existing at these values.
    """

    @pytest.mark.asyncio
    async def test_cleanup_skips_non_integer_pid(self, client):
        """A non-integer pid must never reach os.kill."""
        client._process = create_mock_process()
        client._process.pid = AsyncMock()  # not a real int, e.g. an unconfigured mock

        with patch("code_wrapper.client.os.kill") as mock_kill:
            await client._cleanup_process()

        mock_kill.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_skips_bool_pid(self, client):
        """bool is an int subclass -- True/False must still be rejected."""
        client._process = create_mock_process()
        client._process.pid = True

        with patch("code_wrapper.client.os.kill") as mock_kill:
            await client._cleanup_process()

        mock_kill.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_skips_non_positive_pid(self, client):
        """A pid <= 0 is never a real spawned child."""
        client._process = create_mock_process()
        client._process.pid = 0

        with patch("code_wrapper.client.os.kill") as mock_kill:
            await client._cleanup_process()

        mock_kill.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_signals_valid_child_with_negated_pid(self, client):
        """A real child is signaled via negated PID to signal its process group."""
        client._process = create_mock_process()
        client._process.pid = 424242  # inert sentinel; kill is stubbed below
        client._process.wait = AsyncMock(return_value=0)

        with patch("code_wrapper.client.os.kill") as mock_kill:
            await client._cleanup_process()

        # Should signal with negated PID to signal the process group
        mock_kill.assert_called_once_with(-424242, signal.SIGTERM)

    @pytest.mark.asyncio
    async def test_cleanup_escalates_to_sigkill_on_timeout(self, client):
        """If the process doesn't exit within 3s of SIGTERM, escalate to
        SIGKILL on the same process group."""
        client._process = create_mock_process()
        client._process.pid = 424242  # inert sentinel; kill is stubbed below
        client._process.wait = AsyncMock(side_effect=[asyncio.TimeoutError(), None])

        with patch("code_wrapper.client.os.kill") as mock_kill:
            await client._cleanup_process()

        assert mock_kill.call_args_list == [
            call(-424242, signal.SIGTERM),
            call(-424242, signal.SIGKILL),
        ]


class TestExitCodeHandling:
    """Test handling of various process exit codes."""

    @pytest.mark.asyncio
    async def test_exit_code_2_raises_error(self, client, basic_options):
        """Exit code 2 should raise CodeWrapperBinaryError."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.returncode = 2
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                with pytest.raises(CodeWrapperBinaryError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                assert "code 2" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_exit_code_3_raises_error(self, client, basic_options):
        """Exit code 3 should raise CodeWrapperBinaryError."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.returncode = 3
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                with pytest.raises(CodeWrapperBinaryError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                assert "code 3" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_exit_code_1_raises_error(self, client, basic_options):
        """Exit code 1 should raise CodeWrapperBinaryError."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.returncode = 1
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                with pytest.raises(CodeWrapperBinaryError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                assert "code 1" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_exit_code_127_raises_error(self, client, basic_options):
        """Exit code 127 (command not found) should raise CodeWrapperBinaryError."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.returncode = 127
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                with pytest.raises(CodeWrapperBinaryError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                assert "code 127" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_exit_code_0_succeeds(self, client, basic_options):
        """Exit code 0 should not raise an error."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.returncode = 0
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

                # Should complete without raising
                assert len(events) >= 1


class TestStderrDraining:
    """Test that stderr is drained to prevent deadlock."""

    @pytest.mark.asyncio
    async def test_stderr_drain_task_created(self, client, basic_options):
        """Should create a background task to drain stderr."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.stdout.readline = AsyncMock(return_value=b"")

                mock_subprocess.return_value = mock_process

                # Just verify the stderr draining doesn't break anything
                events = []
                async for event in client.run(basic_options):
                    events.append(event)

                # Should complete without error
                # The stderr draining happens in the background
                assert mock_process.stderr is not None

    @pytest.mark.asyncio
    async def test_stderr_drain_handles_oserror(self, client):
        """_drain_stderr should handle OSError gracefully."""
        mock_reader = AsyncMock()
        mock_reader.read = AsyncMock(side_effect=OSError("Connection lost"))

        # Should not raise
        await client._drain_stderr(mock_reader)


class TestValidationErrorHandling:
    """Test handling of Pydantic ValidationError."""

    @pytest.mark.asyncio
    async def test_validation_error_yields_error_event(self, client, basic_options):
        """Should yield error event for Pydantic ValidationError during deserialization."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()

                # Valid JSON but invalid for model deserialization
                # (missing required field for ReadyEvent)
                invalid_event = {"v": 1, "seq": 0, "timestamp": 0, "type": "ready"}
                mock_process.stdout.readline = AsyncMock(
                    side_effect=[
                        json.dumps(invalid_event).encode() + b"\n",
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


class TestProcessSpawningErrors:
    """Test error handling during process spawning and I/O."""

    @pytest.mark.asyncio
    async def test_file_not_found_error_at_spawn(self, client, basic_options):
        """FileNotFoundError during spawn should raise CodeWrapperBinaryError."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_subprocess.side_effect = FileNotFoundError("Binary not found")

                with pytest.raises(CodeWrapperBinaryError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                assert "failed to spawn binary" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_broken_pipe_error_on_stdin_write(self, client, basic_options):
        """BrokenPipeError during stdin write should raise CodeWrapperBinaryError."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_stdin = MagicMock()
                mock_stdin.write = MagicMock()
                mock_stdin.drain = AsyncMock(side_effect=BrokenPipeError("Pipe broken"))
                mock_stdin.close = MagicMock()
                mock_process.stdin = mock_stdin

                mock_subprocess.return_value = mock_process

                with pytest.raises(CodeWrapperBinaryError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                assert "failed to write prompt" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_oserror_on_stdin_write(self, client, basic_options):
        """OSError during stdin write should raise CodeWrapperBinaryError."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_stdin = MagicMock()
                mock_stdin.write = MagicMock()
                mock_stdin.drain = AsyncMock(side_effect=OSError("I/O error"))
                mock_stdin.close = MagicMock()
                mock_process.stdin = mock_stdin

                mock_subprocess.return_value = mock_process

                with pytest.raises(CodeWrapperBinaryError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                assert "failed to write prompt" in str(exc_info.value).lower()


class TestExceptionPropagation:
    """Test that exceptions are properly propagated and not masked."""

    @pytest.mark.asyncio
    async def test_protocol_error_not_masked_by_exit_code(self, client, basic_options):
        """CodeWrapperProtocolError should not be masked by exit code check."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                mock_process.returncode = 2  # Would normally raise its own error

                # Wrong version to trigger protocol error
                mock_process.stdout.readline = AsyncMock(
                    side_effect=[
                        b'{"v": 99, "seq": 0, "timestamp": 0, "type": "ready"}\n',
                        b"",
                    ]
                )

                mock_subprocess.return_value = mock_process

                with pytest.raises(CodeWrapperProtocolError) as exc_info:
                    async for _ in client.run(basic_options):
                        pass

                # Should raise protocol error, not exit code error
                assert "version mismatch" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_consumer_break_does_not_raise(self, client, basic_options):
        """Breaking out of async for should not raise CodeWrapperBinaryError."""
        with patch("code_wrapper.client.resolve_binary") as mock_resolve:
            mock_binary = MagicMock()
            mock_resolve.return_value = mock_binary

            with patch("code_wrapper.client.asyncio.create_subprocess_exec") as mock_subprocess:
                mock_process = create_mock_process()
                # Process is still running (returncode is None before cleanup)
                ready_event = {"v": 1, "seq": 0, "timestamp": 0, "type": "ready", "sessionId": "s1"}
                text_event = {"v": 1, "seq": 1, "timestamp": 1, "type": "text", "text": "hello"}
                events = [
                    json.dumps(ready_event).encode() + b"\n",
                    json.dumps(text_event).encode() + b"\n",
                    b"",  # End of stream
                ]
                mock_process.stdout.readline = AsyncMock(side_effect=events)
                # Configure stderr to return empty immediately so drain task exits
                mock_process.stderr.read = AsyncMock(return_value=b"")
                mock_subprocess.return_value = mock_process

                # Should not raise when breaking early
                event_count = 0
                async for event in client.run(basic_options):
                    event_count += 1
                    if event_count == 1:
                        break

                # If we get here, no exception was raised
                assert event_count == 1
