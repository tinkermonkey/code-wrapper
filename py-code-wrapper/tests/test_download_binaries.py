"""Tests for binary download script."""

import hashlib
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch


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


class TestDownloadBinary:
    """Test the download_binary function."""

    def test_download_binary_missing_checksum_url(self):
        """Test download_binary rejects when checksum_url is None."""
        module = import_download_module()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "test_binary"

            with patch("urllib.request.urlretrieve") as mock_urlretrieve:
                result = module.download_binary(
                    "http://example.com/binary", output_path, checksum_url=None
                )

                # Should return False and not attempt download
                assert result is False
                mock_urlretrieve.assert_not_called()
                # File should not exist
                assert not output_path.exists()

    def test_download_binary_successful(self):
        """Test successful download with checksum verification."""
        module = import_download_module()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "test_binary"
            test_data = b"test binary content"
            expected_checksum = hashlib.sha256(test_data).hexdigest()

            def mock_urlretrieve(url, path):
                """Write test data to the output file."""
                Path(path).write_bytes(test_data)

            with patch("urllib.request.urlretrieve", side_effect=mock_urlretrieve), patch(
                "urllib.request.urlopen"
            ) as mock_urlopen:
                mock_response = MagicMock()
                mock_response.read.return_value = f"{expected_checksum}\n".encode()
                mock_response.__enter__.return_value = mock_response
                mock_urlopen.return_value = mock_response

                result = module.download_binary(
                    "http://example.com/binary",
                    output_path,
                    checksum_url="http://example.com/binary.sha256",
                )

                # Should return True
                assert result is True
                # File should exist and be executable
                assert output_path.exists()
                assert output_path.stat().st_mode & 0o111  # Check executable bit


class TestMain:
    """Test the main function."""

    def test_main_partial_download_failure(self):
        """Test main returns exit code 1 when only some binaries are downloaded."""
        module = import_download_module()

        # Mock release info with 4 binaries but only 2 checksums
        release_info = {
            "assets": [
                {
                    "name": "code-wrapper-linux-x64",
                    "browser_download_url": "http://example.com/linux-x64",
                },
                {
                    "name": "code-wrapper-linux-x64.sha256",
                    "browser_download_url": "http://example.com/linux-x64.sha256",
                },
                {
                    "name": "code-wrapper-linux-arm64",
                    "browser_download_url": "http://example.com/linux-arm64",
                },
                # Missing checksum for linux-arm64
            ]
        }

        with tempfile.TemporaryDirectory() as tmpdir, patch.object(
            module, "BINARIES_DIR", Path(tmpdir)
        ), patch.object(
            module, "get_release_info", return_value=release_info
        ), patch.object(
            module, "get_current_platform", return_value="linux-x64"
        ), patch(
            "os.environ.get", return_value="all"
        ), patch(
            "urllib.request.urlretrieve"
        ) as mock_urlretrieve, patch(
            "urllib.request.urlopen"
        ) as mock_urlopen:
            # Setup mocks
            test_data = b"test binary"
            expected_checksum = hashlib.sha256(test_data).hexdigest()

            def mock_retrieve(url, path):
                Path(path).write_bytes(test_data)

            mock_urlretrieve.side_effect = mock_retrieve

            mock_response = MagicMock()
            mock_response.read.return_value = f"{expected_checksum}\n".encode()
            mock_response.__enter__.return_value = mock_response
            mock_urlopen.return_value = mock_response

            result = module.main()

            # Should return 1 because not all requested binaries were downloaded
            # (linux-arm64 has no checksum)
            assert result == 1

    def test_main_all_binaries_downloaded(self):
        """Test main returns exit code 0 when all binaries are successfully downloaded."""
        module = import_download_module()

        # Mock release info with all 4 binaries and their checksums
        release_info = {
            "assets": [
                {
                    "name": "code-wrapper-linux-x64",
                    "browser_download_url": "http://example.com/linux-x64",
                },
                {
                    "name": "code-wrapper-linux-x64.sha256",
                    "browser_download_url": "http://example.com/linux-x64.sha256",
                },
                {
                    "name": "code-wrapper-linux-arm64",
                    "browser_download_url": "http://example.com/linux-arm64",
                },
                {
                    "name": "code-wrapper-linux-arm64.sha256",
                    "browser_download_url": "http://example.com/linux-arm64.sha256",
                },
                {
                    "name": "code-wrapper-darwin-x64",
                    "browser_download_url": "http://example.com/darwin-x64",
                },
                {
                    "name": "code-wrapper-darwin-x64.sha256",
                    "browser_download_url": "http://example.com/darwin-x64.sha256",
                },
                {
                    "name": "code-wrapper-darwin-arm64",
                    "browser_download_url": "http://example.com/darwin-arm64",
                },
                {
                    "name": "code-wrapper-darwin-arm64.sha256",
                    "browser_download_url": "http://example.com/darwin-arm64.sha256",
                },
            ]
        }

        with tempfile.TemporaryDirectory() as tmpdir, patch.object(
            module, "BINARIES_DIR", Path(tmpdir)
        ), patch.object(
            module, "get_release_info", return_value=release_info
        ), patch.object(
            module, "get_current_platform", return_value="linux-x64"
        ), patch.dict(
            "os.environ", {"CODE_WRAPPER_VERSION": "all"}
        ), patch(
            "urllib.request.urlretrieve"
        ) as mock_urlretrieve, patch(
            "urllib.request.urlopen"
        ) as mock_urlopen:
            # Setup mocks
            test_data = b"test binary"
            expected_checksum = hashlib.sha256(test_data).hexdigest()

            def mock_retrieve(url, path):
                Path(path).write_bytes(test_data)

            mock_urlretrieve.side_effect = mock_retrieve

            mock_response = MagicMock()
            mock_response.read.return_value = f"{expected_checksum}\n".encode()
            mock_response.__enter__.return_value = mock_response
            mock_urlopen.return_value = mock_response

            result = module.main()

            # Should return 0 because all binaries were downloaded
            assert result == 0
