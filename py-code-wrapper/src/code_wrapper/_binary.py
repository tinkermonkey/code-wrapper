"""Binary resolution for code-wrapper executable.

Resolves the compiled binary in order:
1. CODE_WRAPPER_BINARY environment variable
2. 'code-wrapper' in PATH
3. Package-bundled binary for the current platform
"""

from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path


class CodeWrapperBinaryError(Exception):
    """Raised when the code-wrapper binary cannot be found or executed."""


def _get_platform_binary_name() -> str:
    """Get the platform-specific binary filename.

    Returns binary name for: linux-x64, linux-arm64, darwin-x64, darwin-arm64.
    Raises CodeWrapperBinaryError if the platform is unsupported.
    """
    system = platform.system().lower()
    machine = platform.machine().lower()

    # Normalize machine names
    if machine in ("x86_64", "amd64"):
        arch = "x64"
    elif machine in ("aarch64", "arm64"):
        arch = "arm64"
    else:
        raise CodeWrapperBinaryError(
            f"Unsupported architecture: {machine}. " "Supported: x86_64 (x64), aarch64 (arm64)"
        )

    if system == "linux":
        os_name = "linux"
    elif system == "darwin":
        os_name = "darwin"
    else:
        raise CodeWrapperBinaryError(
            f"Unsupported platform: {system}. " "Supported: linux, darwin (macOS)"
        )

    return f"code-wrapper-{os_name}-{arch}"


def _resolve_from_env() -> Path | None:
    """Resolve binary from CODE_WRAPPER_BINARY environment variable."""
    binary_path = os.environ.get("CODE_WRAPPER_BINARY")
    if binary_path:
        path = Path(binary_path)
        if path.exists() and path.is_file():
            return path
        raise CodeWrapperBinaryError(
            f"CODE_WRAPPER_BINARY points to non-existent file: {binary_path}"
        )
    return None


def _resolve_from_path() -> Path | None:
    """Resolve 'code-wrapper' from PATH."""
    binary_path = shutil.which("code-wrapper")
    if binary_path:
        path = Path(binary_path)
        if path.exists():
            return path
    return None


def _resolve_bundled() -> Path | None:
    """Resolve platform-specific binary bundled in the package."""
    binary_name = _get_platform_binary_name()
    # Package data is in code_wrapper/binaries/ relative to this module
    package_dir = Path(__file__).parent
    binary_path = package_dir / "binaries" / binary_name

    if binary_path.exists():
        return binary_path
    return None


def resolve_binary() -> Path:
    """Resolve the code-wrapper binary.

    Searches in order:
    1. CODE_WRAPPER_BINARY environment variable
    2. 'code-wrapper' in PATH
    3. Package-bundled binary for current platform

    Returns the Path to the binary.
    Raises CodeWrapperBinaryError if not found.
    """
    # Try env var
    binary = _resolve_from_env()
    if binary:
        return binary

    # Try PATH
    binary = _resolve_from_path()
    if binary:
        return binary

    # Try bundled
    binary = _resolve_bundled()
    if binary:
        return binary

    # Not found
    platform_name = _get_platform_binary_name()
    raise CodeWrapperBinaryError(
        f"code-wrapper binary not found. "
        f"Set CODE_WRAPPER_BINARY env var, add it to PATH, "
        f"or ensure the package is properly installed. "
        f"Expected: {platform_name}"
    )
