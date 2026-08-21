"""Setup script for py-code-wrapper.

This script ensures binaries are downloaded from GitHub Releases before building
the package. It's called by setuptools during installation.
"""

import subprocess
import sys
from pathlib import Path
from setuptools import setup


def download_binaries():
    """Download platform-specific binaries from GitHub Releases."""
    script_path = Path(__file__).parent / "scripts" / "download_binaries.py"

    if not script_path.exists():
        print(f"Warning: Binary download script not found at {script_path}", file=sys.stderr)
        return

    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            cwd=Path(__file__).parent,
            check=False,
        )
        if result.returncode != 0:
            print(
                f"Warning: Binary download script exited with code {result.returncode}",
                file=sys.stderr,
            )
    except Exception as e:
        print(f"Warning: Failed to download binaries: {e}", file=sys.stderr)


# Download binaries before setup runs
download_binaries()

# Call setuptools.setup() with config from pyproject.toml
setup()
