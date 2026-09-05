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
# commands silently fail with "no commits". Detect and clean up corrupt state
# so the orchestrator can recreate the worktree on retry.
if [ -e /workspace/.git ]; then
    if ! git -C /workspace rev-parse HEAD >/dev/null 2>&1; then
        echo "ERROR: Git repository at /workspace has no valid HEAD" >&2
        if [ -d /workspace/.git ]; then
            echo "ERROR: .git is a directory (expected a worktree link file) — likely from a failed git init" >&2
            echo "ERROR: Removing corrupt .git directory so the orchestrator can recreate this worktree" >&2
            rm -rf /workspace/.git
        elif [ -f /workspace/.git ]; then
            GITDIR_REF=$(sed -n 's/^gitdir: *//p' /workspace/.git 2>/dev/null)
            echo "ERROR: .git is a worktree link file but gitdir reference is broken: ${GITDIR_REF:-<unreadable>}" >&2
            echo "ERROR: Removing broken .git link so the orchestrator can recreate this worktree" >&2
            rm -f /workspace/.git
        fi
        echo "ERROR: Git state was corrupt and has been cleaned up. This run will exit; retry to get a fresh worktree." >&2
        exit 1
    fi
fi

# Delegate to base image entrypoint (handles SSH setup, then execs $@)
exec /usr/local/bin/docker-entrypoint.sh "$@"
