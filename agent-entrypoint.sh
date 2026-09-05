#!/bin/sh
set -e

# Resolve GitHub token from either env var name (GH_TOKEN takes precedence in gh CLI)
RESOLVED_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"

if [ -n "$RESOLVED_TOKEN" ]; then
    export GH_TOKEN="$RESOLVED_TOKEN"
    export GITHUB_TOKEN="$RESOLVED_TOKEN"
fi

# Prevent gh 2.98+ multi-account config migration from triggering D-Bus/keyring
# access. Any hosts.yml (old or new format) causes gh to attempt migration or
# keyring lookup, both of which fail in headless containers. Symlink to /dev/null
# so writes from the base entrypoint and docker_runner are silently discarded;
# gh then authenticates solely via GH_TOKEN / GITHUB_TOKEN env vars.
mkdir -p "${HOME}/.config/gh"
ln -sf /dev/null "${HOME}/.config/gh/hosts.yml"

# Validate git repository state in the mounted workspace. When the orchestrator
# mounts an epic worktree, the .git file must reference the base clone's
# .git/worktrees/<id> directory — if that reference is broken (e.g. .git is a
# bare directory from a failed git init instead of a worktree link file), git
# commands silently fail with "no commits". Detect this early so the repair
# cycle gets a clear signal instead of cryptic downstream failures.
if [ -d /workspace/.git ]; then
    if ! git -C /workspace rev-parse HEAD >/dev/null 2>&1; then
        echo "WARNING: Git repository at /workspace has no valid HEAD (no commits or broken worktree reference)" >&2
        echo "WARNING: Git operations will fail. The orchestrator may need to recreate this worktree." >&2
    fi
fi

# Delegate to base image entrypoint (handles SSH setup, then execs $@)
exec /usr/local/bin/docker-entrypoint.sh "$@"
