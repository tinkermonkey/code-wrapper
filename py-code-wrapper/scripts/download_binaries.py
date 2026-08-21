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

import os
import sys
import json
import platform
import urllib.request
import urllib.error
from pathlib import Path

# Repository details
GITHUB_OWNER = "tinkermonkey"
GITHUB_REPO = "code-wrapper"
BINARIES_DIR = Path(__file__).parent.parent / "src" / "code_wrapper" / "binaries"


def get_current_platform() -> str:
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


def get_release_info(version: str = "latest") -> dict:
    """Fetch release information from GitHub API.

    Args:
        version: Release version tag (e.g., "v0.1.0") or "latest"

    Returns:
        Release info dict or None if not found
    """
    if version == "latest":
        api_url = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"
    else:
        api_url = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/tags/{version}"

    try:
        with urllib.request.urlopen(api_url) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"Release '{version}' not found for {GITHUB_OWNER}/{GITHUB_REPO}", file=sys.stderr)
            return None
        raise


def download_binary(url: str, output_path: Path) -> bool:
    """Download a single binary file.

    Args:
        url: GitHub release asset URL
        output_path: Where to save the binary

    Returns:
        True if successful, False otherwise
    """
    try:
        print(f"Downloading {output_path.name}...", file=sys.stderr)
        urllib.request.urlretrieve(url, output_path)
        # Make executable
        output_path.chmod(0o755)
        return True
    except Exception as e:
        print(f"Failed to download {output_path.name}: {e}", file=sys.stderr)
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
    else:
        # Download only current platform (for local builds)
        current_platform = get_current_platform()
        if not current_platform:
            print(f"Warning: Unsupported platform ({platform.system()} {platform.machine()})", file=sys.stderr)
            print("Set CODE_WRAPPER_VERSION=all to download all platforms.", file=sys.stderr)
            return 0
        binary_names = [f"code-wrapper-{current_platform}"]

    # Get release info
    release_info = get_release_info(version)
    if not release_info:
        print(f"Warning: Could not fetch release '{version}'. Skipping binary download.", file=sys.stderr)
        print("The package will still work if you provide CODE_WRAPPER_BINARY env var or 'code-wrapper' in PATH.", file=sys.stderr)
        return 0

    # Find and download binaries
    assets = release_info.get("assets", [])
    downloaded_count = 0

    for asset in assets:
        asset_name = asset.get("name", "")
        if asset_name in binary_names:
            download_url = asset.get("browser_download_url")
            output_path = BINARIES_DIR / asset_name

            if download_binary(download_url, output_path):
                downloaded_count += 1

    if downloaded_count == 0:
        print(f"Warning: No binaries were downloaded from release '{version}'.", file=sys.stderr)
        print("The package will still work if you provide CODE_WRAPPER_BINARY env var or 'code-wrapper' in PATH.", file=sys.stderr)
        return 0

    print(f"Successfully downloaded {downloaded_count}/{len(binary_names)} binaries from {version}.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
