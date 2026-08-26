#!/usr/bin/env python3
"""Download code-wrapper binaries from GitHub Releases.

This script fetches platform-specific binaries from GitHub Releases and places them
in the package's binaries directory. It's called during the build process via
pyproject.toml's [build-system] hook.

By default, downloads only the binary matching the current platform. Set
CODE_WRAPPER_VERSION to specify a release version (e.g., "v0.1.0"), or set it to
"all" to download all four platforms (for wheel distribution).

Supported platforms:
- code-wrapper-linux-x64
- code-wrapper-linux-arm64
- code-wrapper-darwin-x64
- code-wrapper-darwin-arm64
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, cast

# Repository details
GITHUB_OWNER = "tinkermonkey"
GITHUB_REPO = "code-wrapper"
BINARIES_DIR = Path(__file__).parent.parent / "src" / "code_wrapper" / "binaries"


def get_current_platform() -> str | None:
    """Detect the current platform and return the matching binary name suffix.

    Returns:
        A string like "linux-x64", "linux-arm64", "darwin-x64", or "darwin-arm64"
        Returns None if platform is not supported.
    """
    system = platform.system().lower()
    machine = platform.machine().lower()

    if system == "linux":
        if machine in ("x86_64", "amd64"):
            return "linux-x64"
        elif machine in ("aarch64", "arm64"):
            return "linux-arm64"
    elif system == "darwin":
        if machine in ("x86_64", "amd64"):
            return "darwin-x64"
        elif machine in ("arm64", "aarch64"):
            return "darwin-arm64"

    return None


def get_release_info(version: str = "latest") -> dict[Any, Any] | None:
    """Fetch release information from GitHub API.

    Args:
        version: Release version tag (e.g., "v0.1.0") or "latest"

    Returns:
        Release info dict or None if not found
    """
    if version == "latest":
        api_url = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"
    else:
        api_url = (
            f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/tags/{version}"
        )

    try:
        with urllib.request.urlopen(api_url) as response:
            return cast(dict[Any, Any], json.loads(response.read().decode()))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(
                f"Release '{version}' not found for {GITHUB_OWNER}/{GITHUB_REPO}", file=sys.stderr
            )
            return None
        raise


def verify_checksum(file_path: Path, checksum_url: str) -> bool:
    """Verify a binary file against its SHA256 checksum.

    Args:
        file_path: Path to the binary file to verify
        checksum_url: URL to download the checksum from

    Returns:
        True if verification succeeds, False otherwise
    """
    try:
        with urllib.request.urlopen(checksum_url) as response:
            checksum_data = response.read().decode().strip()

        if not checksum_data:
            print(
                f"Checksum verification failed for {file_path.name}: empty checksum file",
                file=sys.stderr,
            )
            return False

        expected_checksum = checksum_data.split()[0]

        sha256_hash = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                sha256_hash.update(chunk)

        actual_checksum = sha256_hash.hexdigest()
        if actual_checksum != expected_checksum:
            print(
                f"Checksum verification failed for {file_path.name}: "
                f"expected {expected_checksum}, got {actual_checksum}",
                file=sys.stderr,
            )
            return False
        return True
    except (urllib.error.URLError, OSError) as e:
        print(f"Failed to verify checksum for {file_path.name}: {e}", file=sys.stderr)
        return False


def download_binary(url: str, output_path: Path, checksum_url: str | None = None) -> bool:
    """Download a single binary file with checksum verification.

    Args:
        url: GitHub release asset URL
        output_path: Where to save the binary
        checksum_url: URL to download checksum from (optional — download is rejected if not provided)

    Returns:
        True if successful and verified, False otherwise
    """
    if not checksum_url:
        print(
            f"Failed to download {output_path.name}: no checksum file found for integrity verification",
            file=sys.stderr,
        )
        return False

    try:
        print(f"Downloading {output_path.name}...", file=sys.stderr)
        urllib.request.urlretrieve(url, output_path)

        if not verify_checksum(output_path, checksum_url):
            output_path.unlink(missing_ok=True)
            return False

        # Make executable
        output_path.chmod(0o755)
        return True
    except (urllib.error.URLError, OSError) as e:
        print(f"Failed to download {output_path.name}: {e}", file=sys.stderr)
        output_path.unlink(missing_ok=True)
        return False


def main():
    """Download platform-specific binaries from GitHub Releases."""
    # Create binaries directory if it doesn't exist
    BINARIES_DIR.mkdir(parents=True, exist_ok=True)

    # Determine version to download
    version = os.environ.get("CODE_WRAPPER_VERSION", "latest")

    # Determine which binaries to download
    if version == "all":
        # Download all platforms (for PyPI wheel distribution)
        binary_names = [
            "code-wrapper-linux-x64",
            "code-wrapper-linux-arm64",
            "code-wrapper-darwin-x64",
            "code-wrapper-darwin-arm64",
        ]
        # Use "latest" to fetch release info, but download all platforms
        release_version = "latest"
    else:
        # Download only current platform (for local builds)
        current_platform = get_current_platform()
        if not current_platform:
            print(
                f"Error: Unsupported platform ({platform.system()} {platform.machine()})",
                file=sys.stderr,
            )
            print("Set CODE_WRAPPER_VERSION=all to download all platforms.", file=sys.stderr)
            return 1
        binary_names = [f"code-wrapper-{current_platform}"]
        release_version = version

    # Get release info
    release_info = get_release_info(release_version)
    if not release_info:
        print(
            f"Error: Could not fetch release '{release_version}'. Skipping binary download.",
            file=sys.stderr,
        )
        print(
            "The package will still work if you provide CODE_WRAPPER_BINARY env var or 'code-wrapper' in PATH.",
            file=sys.stderr,
        )
        return 1

    # Build a map of checksum URLs by binary name
    checksum_urls: dict[str, str] = {}
    for asset in release_info.get("assets", []):
        asset_name = asset.get("name", "")
        if asset_name.endswith(".sha256"):
            binary_name = asset_name[:-7]
            checksum_urls[binary_name] = asset.get("browser_download_url", "")

    # Find and download binaries
    assets = release_info.get("assets", [])
    downloaded_count = 0

    for asset in assets:
        asset_name = asset.get("name", "")
        if asset_name in binary_names:
            download_url = asset.get("browser_download_url")
            output_path = BINARIES_DIR / asset_name
            checksum_url = checksum_urls.get(asset_name)

            if download_binary(download_url, output_path, checksum_url):
                downloaded_count += 1

    if downloaded_count == 0:
        print(
            f"Error: No binaries were downloaded from release '{release_version}'.",
            file=sys.stderr,
        )
        print(
            "The package will still work if you provide CODE_WRAPPER_BINARY env var or 'code-wrapper' in PATH.",
            file=sys.stderr,
        )
        return 1

    if downloaded_count != len(binary_names):
        print(
            f"Error: Failed to download all requested binaries. Downloaded {downloaded_count}/{len(binary_names)} from release '{release_version}'.",
            file=sys.stderr,
        )
        print(
            "The package will still work if you provide CODE_WRAPPER_BINARY env var or 'code-wrapper' in PATH.",
            file=sys.stderr,
        )
        return 1

    print(
        f"Successfully downloaded {downloaded_count}/{len(binary_names)} binaries from {release_version}.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
