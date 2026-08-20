"""Tests for code-wrapper binary resolution."""

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from code_wrapper._binary import (
    resolve_binary,
    CodeWrapperBinaryError,
    _get_platform_binary_name,
    _resolve_from_env,
    _resolve_from_path,
)


class TestPlatformBinaryName:
    """Test platform-specific binary name generation."""

    @patch("platform.system")
    @patch("platform.machine")
    def test_linux_x64(self, mock_machine, mock_system):
        mock_system.return_value = "Linux"
        mock_machine.return_value = "x86_64"
        assert _get_platform_binary_name() == "code-wrapper-linux-x64"

    @patch("platform.system")
    @patch("platform.machine")
    def test_linux_arm64(self, mock_machine, mock_system):
        mock_system.return_value = "Linux"
        mock_machine.return_value = "aarch64"
        assert _get_platform_binary_name() == "code-wrapper-linux-arm64"

    @patch("platform.system")
    @patch("platform.machine")
    def test_darwin_x64(self, mock_machine, mock_system):
        mock_system.return_value = "Darwin"
        mock_machine.return_value = "x86_64"
        assert _get_platform_binary_name() == "code-wrapper-darwin-x64"

    @patch("platform.system")
    @patch("platform.machine")
    def test_darwin_arm64(self, mock_machine, mock_system):
        mock_system.return_value = "Darwin"
        mock_machine.return_value = "arm64"
        assert _get_platform_binary_name() == "code-wrapper-darwin-arm64"

    @patch("platform.system")
    @patch("platform.machine")
    def test_unsupported_os(self, mock_machine, mock_system):
        mock_system.return_value = "Windows"
        mock_machine.return_value = "x86_64"
        with pytest.raises(CodeWrapperBinaryError) as exc_info:
            _get_platform_binary_name()
        assert "Unsupported platform" in str(exc_info.value)

    @patch("platform.system")
    @patch("platform.machine")
    def test_unsupported_arch(self, mock_machine, mock_system):
        mock_system.return_value = "Linux"
        mock_machine.return_value = "mips64"
        with pytest.raises(CodeWrapperBinaryError) as exc_info:
            _get_platform_binary_name()
        assert "Unsupported architecture" in str(exc_info.value)


class TestResolveFromEnv:
    """Test binary resolution from environment variable."""

    def test_resolve_from_existing_env_var(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name

        try:
            with patch.dict(os.environ, {"CODE_WRAPPER_BINARY": temp_path}):
                result = _resolve_from_env()
                assert result == Path(temp_path)
        finally:
            Path(temp_path).unlink()

    def test_resolve_from_missing_env_var_path(self):
        with patch.dict(os.environ, {"CODE_WRAPPER_BINARY": "/nonexistent/path"}):
            with pytest.raises(CodeWrapperBinaryError) as exc_info:
                _resolve_from_env()
            assert "non-existent file" in str(exc_info.value)

    def test_resolve_from_missing_env_var(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CODE_WRAPPER_BINARY", None)
            result = _resolve_from_env()
            assert result is None


class TestResolveFromPath:
    """Test binary resolution from PATH."""

    @patch("subprocess.run")
    def test_resolve_found_in_path(self, mock_run):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name

        try:
            mock_run.return_value.returncode = 0
            mock_run.return_value.stdout = temp_path

            result = _resolve_from_path()
            assert result == Path(temp_path)
        finally:
            Path(temp_path).unlink()

    @patch("subprocess.run")
    def test_resolve_not_in_path(self, mock_run):
        mock_run.return_value.returncode = 1
        result = _resolve_from_path()
        assert result is None

    @patch("subprocess.run")
    def test_resolve_which_not_available(self, mock_run):
        mock_run.side_effect = FileNotFoundError()
        result = _resolve_from_path()
        assert result is None


class TestResolveBinary:
    """Test complete binary resolution logic."""

    def test_env_var_takes_precedence(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name

        try:
            with patch.dict(os.environ, {"CODE_WRAPPER_BINARY": temp_path}):
                with patch("code_wrapper._binary._resolve_from_path", return_value=None):
                    with patch("code_wrapper._binary._resolve_bundled", return_value=None):
                        result = resolve_binary()
                        assert result == Path(temp_path)
        finally:
            Path(temp_path).unlink()

    def test_path_second_priority(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name

        try:
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CODE_WRAPPER_BINARY", None)
                with patch("code_wrapper._binary._resolve_from_path", return_value=Path(temp_path)):
                    with patch("code_wrapper._binary._resolve_bundled", return_value=None):
                        result = resolve_binary()
                        assert result == Path(temp_path)
        finally:
            Path(temp_path).unlink()

    def test_bundled_third_priority(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            temp_path = f.name

        try:
            with patch.dict(os.environ, {}, clear=False):
                os.environ.pop("CODE_WRAPPER_BINARY", None)
                with patch("code_wrapper._binary._resolve_from_path", return_value=None):
                    with patch("code_wrapper._binary._resolve_bundled", return_value=Path(temp_path)):
                        result = resolve_binary()
                        assert result == Path(temp_path)
        finally:
            Path(temp_path).unlink()

    def test_not_found_raises_error(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("CODE_WRAPPER_BINARY", None)
            with patch("code_wrapper._binary._resolve_from_path", return_value=None):
                with patch("code_wrapper._binary._resolve_bundled", return_value=None):
                    with pytest.raises(CodeWrapperBinaryError) as exc_info:
                        resolve_binary()
                    assert "not found" in str(exc_info.value).lower()
