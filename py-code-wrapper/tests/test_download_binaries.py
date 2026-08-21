"""Tests for binary download script."""

import hashlib
import tempfile
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def get_script_path():
    """Get the path to the download_binaries script."""
    return Path(__file__).parent.parent / "scripts" / "download_binaries.py"


def import_download_module():
    """Import the download_binaries module dynamically."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "download_binaries", get_script_path()
    )
    if spec and spec.loader:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    raise ImportError("Could not load download_binaries module")


class TestVerifyChecksum:
    """Test the verify_checksum function."""

    def test_verify_checksum_match(self):
        """Test successful checksum verification."""
        module = import_download_module()

        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            tmp_path = Path(tmp_file.name)
            test_data = b"test binary content"
            tmp_file.write(test_data)
            tmp_file.flush()

            expected_checksum = hashlib.sha256(test_data).hexdigest()
            checksum_content = f"{expected_checksum}\n"

            try:
                with patch(
                    "urllib.request.urlopen"
                ) as mock_urlopen:
                    mock_response = MagicMock()
                    mock_response.read.return_value = checksum_content.encode()
                    mock_response.__enter__.return_value = mock_response

                    mock_urlopen.return_value = mock_response

                    result = module.verify_checksum(tmp_path, "http://example.com/checksum.sha256")
                    assert result is True
            finally:
                tmp_path.unlink()

    def test_verify_checksum_mismatch(self):
        """Test checksum verification failure with mismatched checksum."""
        module = import_download_module()

        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            tmp_path = Path(tmp_file.name)
            test_data = b"test binary content"
            tmp_file.write(test_data)
            tmp_file.flush()

            wrong_checksum = "0" * 64

            try:
                with patch(
                    "urllib.request.urlopen"
                ) as mock_urlopen:
                    mock_response = MagicMock()
                    mock_response.read.return_value = f"{wrong_checksum}\n".encode()
                    mock_response.__enter__.return_value = mock_response

                    mock_urlopen.return_value = mock_response

                    result = module.verify_checksum(tmp_path, "http://example.com/checksum.sha256")
                    assert result is False
            finally:
                tmp_path.unlink()

    def test_verify_checksum_empty_file(self):
        """Test checksum verification with empty checksum file."""
        module = import_download_module()

        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            tmp_path = Path(tmp_file.name)
            test_data = b"test binary content"
            tmp_file.write(test_data)
            tmp_file.flush()

            try:
                with patch(
                    "urllib.request.urlopen"
                ) as mock_urlopen:
                    mock_response = MagicMock()
                    mock_response.read.return_value = b""
                    mock_response.__enter__.return_value = mock_response

                    mock_urlopen.return_value = mock_response

                    result = module.verify_checksum(tmp_path, "http://example.com/checksum.sha256")
                    assert result is False
            finally:
                tmp_path.unlink()

    def test_verify_checksum_network_error(self):
        """Test checksum verification with network error."""
        module = import_download_module()

        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            tmp_path = Path(tmp_file.name)
            test_data = b"test binary content"
            tmp_file.write(test_data)
            tmp_file.flush()

            try:
                with patch(
                    "urllib.request.urlopen"
                ) as mock_urlopen:
                    import urllib.error
                    mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

                    result = module.verify_checksum(tmp_path, "http://example.com/checksum.sha256")
                    assert result is False
            finally:
                tmp_path.unlink()

    def test_verify_checksum_file_not_found(self):
        """Test checksum verification when binary file doesn't exist."""
        module = import_download_module()

        nonexistent_path = Path("/nonexistent/path/to/binary")

        with patch(
            "urllib.request.urlopen"
        ) as mock_urlopen:
            expected_checksum = "0" * 64
            mock_response = MagicMock()
            mock_response.read.return_value = f"{expected_checksum}\n".encode()
            mock_response.__enter__.return_value = mock_response

            mock_urlopen.return_value = mock_response

            result = module.verify_checksum(nonexistent_path, "http://example.com/checksum.sha256")
            assert result is False
