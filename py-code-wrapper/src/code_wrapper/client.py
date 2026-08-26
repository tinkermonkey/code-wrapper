"""Async client for code-wrapper binary.

Spawns the binary and exposes an async generator yielding typed ClaudeEvent objects.
No protocol knowledge — only JSON deserialization and type discrimination.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
from collections.abc import AsyncGenerator

from ._binary import CodeWrapperBinaryError, resolve_binary
from .models import ClaudeEvent, ErrorEvent, deserialize_event


class CodeWrapperProtocolError(Exception):
    """Raised when wire protocol version mismatch is detected."""


class ClientOptions:
    """Options for running the client."""

    def __init__(
        self,
        cwd: str,
        prompt: str,
        session_id: str | None = None,
        is_first_message: bool = True,
        idle_timeout: int = 300,
        max_timeout: int = 3600,
        skip_permissions: bool = False,
        agent: str | None = None,
        mcp_config_path: str | None = None,
        backend: str = "claude",
    ):
        self.cwd = cwd
        self.prompt = prompt
        self.session_id = session_id
        self.is_first_message = is_first_message
        self.idle_timeout = idle_timeout
        self.max_timeout = max_timeout
        self.skip_permissions = skip_permissions
        self.agent = agent
        self.mcp_config_path = mcp_config_path
        self.backend = backend


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
                preexec_fn=self._preexec_fn if hasattr(os, "setpgrp") else None,
            )
        except FileNotFoundError as e:
            raise CodeWrapperBinaryError(f"Failed to spawn binary: {e}") from e

        # Write prompt to stdin and close it
        try:
            if self._process.stdin:
                self._process.stdin.write(options.prompt.encode("utf-8"))
                await self._process.stdin.drain()
                self._process.stdin.close()
        except (BrokenPipeError, OSError) as e:
            raise CodeWrapperBinaryError(f"Failed to write prompt: {e}") from e

        # Read and yield events
        first_event = True
        try:
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
                    except ValueError as e:
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

        finally:
            # Clean up process
            if self._process:
                await self._cleanup_process()
                # Check for binary error exit codes
                if self._process.returncode == 2:
                    raise CodeWrapperBinaryError("Binary exited with code 2 (fatal error)")

    @staticmethod
    def _preexec_fn():
        """Pre-exec function to start a new process group."""
        if hasattr(os, "setpgrp"):
            os.setpgrp()

    async def _cleanup_process(self):
        """Clean up the spawned process with SIGTERM → 3s → SIGKILL escalation."""
        if not self._process:
            return

        try:
            # Try SIGTERM on the process group
            if self._process.returncode is None:
                if not self._signal_process_group(signal.SIGTERM):
                    return

                # Wait up to 3 seconds for graceful shutdown
                try:
                    await asyncio.wait_for(self._process.wait(), timeout=3.0)
                except asyncio.TimeoutError:
                    # SIGTERM didn't work, escalate to SIGKILL on the process group
                    if not self._signal_process_group(signal.SIGKILL):
                        return

                    try:
                        await asyncio.wait_for(self._process.wait(), timeout=1.0)
                    except asyncio.TimeoutError:
                        pass

        except ProcessLookupError:
            # Process already dead
            pass

    def _signal_process_group(self, sig: int) -> bool:
        """Send `sig` to the spawned process's group, guarding against bogus pids.

        os.getpgid()/os.killpg() coerce their pid argument via the __index__
        protocol, so a non-integer pid (e.g. an unconfigured test double)
        silently resolves to some unrelated value instead of raising —
        os.getpgid(unconfigured_mock.pid) resolves to 1 by default. Left
        unguarded, that can signal PID 1's own process group (the whole
        surrounding container/session) rather than the intended child.

        Returns False (no signal sent) if there is no process, the pid isn't
        a real integer, the process is already gone, or the resolved group
        matches our own — that last case can only happen for a bogus pid,
        since the child is always spawned into its own fresh group via
        `_preexec_fn`.
        """
        if not self._process:
            return False

        pid = self._process.pid
        if not isinstance(pid, int):
            return False

        try:
            pgid = os.getpgid(pid)
        except ProcessLookupError:
            return False

        if pgid == os.getpgid(0):
            return False

        os.killpg(pgid, sig)
        return True

    @staticmethod
    async def _read_lines(reader: asyncio.StreamReader) -> AsyncGenerator[str, None]:
        """Read lines from a stream reader."""
        while True:
            try:
                line = await reader.readline()
                if not line:
                    break
                yield line.decode("utf-8", errors="replace")
            except OSError:
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
