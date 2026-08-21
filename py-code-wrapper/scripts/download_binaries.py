#!/usr/bin/env python3
"""Download code-wrapper binaries from GitHub Releases.

This script fetches platform-specific binaries from GitHub Releases and places them
in the package's binaries directory. It's called during the build process via
pyproject.toml's [build-system] hook.

Binaries are downloaded for all four supported platforms:
- code-wrapper-linux-x64
- code-wrapper-linux-arm64
- code-wrapper-darwin-x64
- code-wrapper-darwin-arm64
"""

import os
import sys
import json
import urllib.request
import urllib.error
from pathlib import Path

# Repository details
GITHUB_OWNER = "tinkermonkey"
GITHUB_REPO = "code-wrapper"
BINARIES_DIR = Path(__file__).parent.parent / "src" / "code_wrapper" / "binaries"


def get_latest_release_info() -> dict:
    """Fetch the latest release information from GitHub API."""
    api_url = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest"

    try:
        with urllib.request.urlopen(api_url) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print(f"No releases found for {GITHUB_OWNER}/{GITHUB_REPO}", file=sys.stderr)
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
    """Download all platform-specific binaries from the latest release."""
    # Create binaries directory if it doesn't exist
    BINARIES_DIR.mkdir(parents=True, exist_ok=True)

    # Get latest release info
    release_info = get_latest_release_info()
    if not release_info:
        print("Warning: Could not fetch latest release info. Skipping binary download.", file=sys.stderr)
        # Don't fail the build if we can't download - the package can still work
        # with CODE_WRAPPER_BINARY env var or PATH
        return 0

    # Expected binary names for all platforms
    binary_names = [
        "code-wrapper-linux-x64",
        "code-wrapper-linux-arm64",
        "code-wrapper-darwin-x64",
        "code-wrapper-darwin-arm64",
    ]

    # Find and download each binary
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
        print("Warning: No binaries were downloaded from the latest release.", file=sys.stderr)
        print("The package will still work if you provide CODE_WRAPPER_BINARY env var or 'code-wrapper' in PATH.", file=sys.stderr)
        return 0

    print(f"Successfully downloaded {downloaded_count}/{len(binary_names)} binaries.", file=sys.stderr)
    return 0 if downloaded_count > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
