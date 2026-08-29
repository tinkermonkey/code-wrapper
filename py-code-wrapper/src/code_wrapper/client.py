"""Async client for code-wrapper binary.

Spawns the binary and exposes an async generator yielding typed ClaudeEvent objects.
No protocol knowledge — only JSON deserialization and type discrimination.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from collections.abc import AsyncGenerator

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ._binary import CodeWrapperBinaryError, resolve_binary
from .models import ClaudeEvent, ErrorEvent, deserialize_event

logger = logging.getLogger(__name__)


class CodeWrapperProtocolError(Exception):
    """Raised when wire protocol version mismatch is detected."""


class ClientOptions(BaseModel):
    """Options for running the client."""

    model_config = ConfigDict(str_strip_whitespace=False)

    cwd: str
    prompt: str
    session_id: str | None = None
    is_first_message: bool = True
    idle_timeout: int = Field(default=300, gt=0)
    max_timeout: int = Field(default=3600, gt=0)
    skip_permissions: bool = False
    agent: str | None = None
    mcp_config_path: str | None = None
    backend: str = Field(default="claude", pattern="^[a-z]+$")
    session_dir: str | None = None
    recover_stale_session: bool = False

    @field_validator("cwd")
    @classmethod
    def validate_cwd(cls, v: str) -> str:
        """Validate that cwd is not empty."""
        if not v or not v.strip():
            raise ValueError("cwd must not be empty")
        return v

    @field_validator("prompt")
    @classmethod
    def validate_prompt(cls, v: str) -> str:
        """Validate that prompt is not empty."""
        if not v or not v.strip():
            raise ValueError("prompt must not be empty")
        return v

    @field_validator("max_timeout")
    @classmethod
    def validate_max_timeout(cls, v: int, info) -> int:
        """Validate that max_timeout >= idle_timeout."""
        idle_timeout = info.data.get("idle_timeout", 300)
        if v < idle_timeout:
            raise ValueError(f"max_timeout ({v}) must be >= idle_timeout ({idle_timeout})")
        return v


class CodeWrapper:
    """Async client for code-wrapper binary.

    Example:
        client = CodeWrapper()
        async for event in client.run(options):
            print(event)
    """

    def __init__(self):
        """Initialize the client."""
        self._process: asyncio.subprocess.Process | None = None
        self._stderr_buffer: str = ""

    async def run(self, options: ClientOptions) -> AsyncGenerator[ClaudeEvent, None]:
        """Run the binary and yield typed events.

        Spawns the binary with the given options and deserializes NDJSON output.
        Checks wire protocol version on first event and raises CodeWrapperProtocolError
        on mismatch.

        Yields:
            ClaudeEvent objects in order from the binary

        Raises:
            CodeWrapperBinaryError: if binary cannot be found
            CodeWrapperProtocolError: if wire protocol version mismatch
            Other exceptions from binary execution
        """
        # Reset stderr buffer for this run
        self._stderr_buffer = ""

        binary_path = resolve_binary()

        # Build command arguments
        args = [str(binary_path), "--backend", options.backend]

        if options.agent:
            args.extend(["--agent", options.agent])

        args.extend(["--cwd", options.cwd])

        if options.skip_permissions:
            args.append("--skip-permissions")

        if options.mcp_config_path:
            args.extend(["--mcp-config", options.mcp_config_path])

        if options.session_id:
            if options.is_first_message:
                args.extend(["--session-id", options.session_id])
            else:
                args.extend(["--resume", options.session_id])

        if options.session_dir:
            args.extend(["--session-dir", options.session_dir])

        if options.recover_stale_session:
            args.append("--recover-stale-session")

        args.extend(["--idle-timeout", str(options.idle_timeout)])
        args.extend(["--max-timeout", str(options.max_timeout)])

        # Delete CLAUDECODE env var to prevent nested session refusal
        env = dict(os.environ)
        env.pop("CLAUDECODE", None)

        # Spawn process
        try:
            self._process = await asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=options.cwd,
                env=env,
                start_new_session=True if hasattr(os, "setsid") else False,
            )
        except FileNotFoundError as e:
            raise CodeWrapperBinaryError(f"Failed to spawn binary: {e}") from e

        # Drain stderr in background to prevent deadlock
        stderr_task = None
        if self._process.stderr:
            stderr_task = asyncio.create_task(self._drain_stderr(self._process.stderr))

        # Read and yield events
        first_event = True
        exception_raised = None
        try:
            # Write prompt to stdin and close it
            try:
                if self._process.stdin:
                    self._process.stdin.write(options.prompt.encode("utf-8"))
                    await self._process.stdin.drain()
                    self._process.stdin.close()
            except (BrokenPipeError, OSError) as e:
                raise CodeWrapperBinaryError(f"Failed to write prompt: {e}") from e

            if self._process.stdout:
                async for line in self._read_lines(self._process.stdout):
                    if not line.strip():
                        continue

                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError as e:
                        yield ErrorEvent(
                            v=1,
                            seq=0,
                            timestamp=0,
                            type="error",
                            code="parse_error",
                            detail=f"Failed to parse JSON: {e}",
                            exitCode=None,
                        )
                        continue

                    # Check wire protocol version on first event
                    if first_event:
                        first_event = False
                        wire_version = data.get("v")
                        if wire_version != 1:
                            raise CodeWrapperProtocolError(
                                f"Wire protocol version mismatch: expected 1, got {wire_version}"
                            )

                    # Deserialize and yield
                    try:
                        event = deserialize_event(data)
                        yield event
                    except ValidationError as e:
                        # Yield parse error but continue
                        yield ErrorEvent(
                            v=1,
                            seq=data.get("seq", 0),
                            timestamp=data.get("timestamp", 0),
                            type="error",
                            code="parse_error",
                            detail=f"Failed to deserialize event: {e}",
                            exitCode=None,
                        )

        except Exception as e:
            exception_raised = e
        finally:
            # Cancel stderr drain task
            if stderr_task:
                stderr_task.cancel()
                try:
                    await stderr_task
                except asyncio.CancelledError:
                    pass

            # Track if we're about to terminate the process ourselves
            terminated_by_cleanup = self._process is not None and self._process.returncode is None

            # Clean up process
            if self._process:
                await self._cleanup_process()

            # Only raise exit code errors if:
            # 1. No exception was already raised
            # 2. We didn't terminate the process ourselves (e.g., GeneratorExit break)
            if exception_raised is None and self._process and not terminated_by_cleanup:
                if self._process.returncode == 2:
                    error_msg = "Binary exited with code 2 (fatal error)"
                    if self._stderr_buffer:
                        error_msg += f"\n{self._stderr_buffer}"
                    raise CodeWrapperBinaryError(error_msg)
                elif self._process.returncode == 3:
                    error_msg = "Binary exited with code 3 (wire protocol error)"
                    if self._stderr_buffer:
                        error_msg += f"\n{self._stderr_buffer}"
                    raise CodeWrapperProtocolError(error_msg)
                elif self._process.returncode is not None and self._process.returncode != 0:
                    error_msg = f"Binary exited with code {self._process.returncode}"
                    if self._stderr_buffer:
                        error_msg += f"\n{self._stderr_buffer}"
                    raise CodeWrapperBinaryError(error_msg)

            # Re-raise any exception that was caught
            if exception_raised is not None:
                raise exception_raised

    async def _drain_stderr(self, reader: asyncio.StreamReader) -> None:
        """Buffer stderr to prevent deadlock and capture diagnostic output.

        Accumulates stderr content for error diagnostics when the binary exits.
        """
        while True:
            try:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                self._stderr_buffer += chunk.decode("utf-8", errors="replace")
            except OSError:
                break

    async def _cleanup_process(self):
        """Clean up the spawned process with SIGTERM → 3s → SIGKILL escalation.

        Uses negated PID to signal the process group; since the child was spawned
        with start_new_session=True, it is its own process group leader.
        """
        if not self._process:
            return

        try:
            # Try SIGTERM on the process
            if self._process.returncode is None:
                if self._validate_and_signal_process(signal.SIGTERM):
                    # Wait up to 3 seconds for graceful shutdown
                    try:
                        await asyncio.wait_for(self._process.wait(), timeout=3.0)
                    except asyncio.TimeoutError:
                        # SIGTERM didn't work, escalate to SIGKILL
                        self._validate_and_signal_process(signal.SIGKILL)
                        try:
                            await asyncio.wait_for(self._process.wait(), timeout=1.0)
                        except asyncio.TimeoutError:
                            pass

        except ProcessLookupError:
            # Process already dead
            pass

    def _validate_and_signal_process(self, sig: int) -> bool:
        """Send `sig` to the spawned process group, guarding against bogus pids.

        os.kill() coerces its pid argument via the __index__ protocol,
        so a non-integer pid (e.g. an unconfigured test double) silently
        resolves to some unrelated value instead of raising. Left unguarded,
        that could signal an unrelated process.

        Since the child is spawned with start_new_session=True, it is its own
        process group leader. We signal it with a negated PID to signal the
        entire process group (child + descendants), which is typically desired
        for cleanup.

        Returns False (no signal sent) if there is no process, the process
        is already gone, or the pid is invalid. Logs warnings for invalid pids
        since they indicate a bug rather than a normal exit.
        """
        if not self._process:
            return False

        pid = self._process.pid
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            logger.warning(
                "_validate_and_signal_process: process.pid is not a valid pid (%r); "
                "refusing to signal",
                pid,
            )
            return False

        try:
            # Use negated PID to signal the entire process group (child + descendants)
            os.kill(-pid, sig)
            return True
        except ProcessLookupError:
            # Process already exited -- nothing to signal, not a bug.
            return False

    @staticmethod
    async def _read_lines(reader: asyncio.StreamReader) -> AsyncGenerator[str, None]:
        """Read lines from a stream reader."""
        while True:
            try:
                line = await reader.readline()
                if not line:
                    break
                yield line.decode("utf-8", errors="replace")
            except OSError as e:
                logger.warning("Error reading from stdout: %s", e)
                break


async def run(options: ClientOptions) -> AsyncGenerator[ClaudeEvent, None]:
    """Convenience function to run the client.

    Usage:
        async for event in code_wrapper.run(options):
            print(event)

    Args:
        options: ClientOptions with prompt, cwd, etc.

    Yields:
        ClaudeEvent objects from the binary
    """
    client = CodeWrapper()
    async for event in client.run(options):
        yield event
