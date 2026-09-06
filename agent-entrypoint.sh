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
#
# Gate on Dockerfile.agent OR .git being present, not .git alone: a
# discussions-workspace dispatch (this project's planning_design pipeline)
# mounts a plain scratch temp directory at /workspace instead of a real
# checkout (orchestrator's DiscussionsWorkspaceContext.get_working_directory(),
# a fresh /tmp/discussions/<project> dir) — that legitimately has neither
# Dockerfile.agent nor .git, and must NOT be flagged as corrupt. Dockerfile.agent
# is present in every REAL checkout of this project by construction: it's what
# this very image was built from, so its absence here would mean this
# container couldn't have been built in the first place. Its presence with
# .git completely missing is exactly the "no .git present at all" corruption
# shape the git-state check below previously didn't cover at all (found by
# dev_environment_verifier, tracked as a dev-container-blocking finding).
if [ -f /workspace/Dockerfile.agent ] || [ -e /workspace/.git ]; then
    if ! git -C /workspace rev-parse --verify HEAD >/dev/null 2>&1; then
        echo "ERROR: Git repository at /workspace has no valid HEAD" >&2
        if [ -d /workspace/.git ]; then
            echo "ERROR: .git is a directory (expected a worktree link file) — likely from a failed git init" >&2
            echo "ERROR: Removing corrupt .git directory so the orchestrator can recreate this worktree" >&2
            rm -rf /workspace/.git 2>/dev/null || echo "ERROR: Could not remove .git directory (permission denied)" >&2
        elif [ -f /workspace/.git ]; then
            GITDIR_REF=$(sed -n 's/^gitdir: *//p' /workspace/.git 2>/dev/null)
            echo "ERROR: .git is a worktree link file but gitdir reference is broken: ${GITDIR_REF:-<unreadable>}" >&2
            echo "ERROR: Removing broken .git link so the orchestrator can recreate this worktree" >&2
            rm -f /workspace/.git 2>/dev/null || echo "ERROR: Could not remove .git link file (permission denied)" >&2
        else
            echo "ERROR: No .git present at /workspace at all (expected a worktree link file or repository — Dockerfile.agent, a real project file, IS present, so this is a genuine checkout, not a discussions scratch dir)" >&2
            echo "ERROR: Nothing on disk to remove, but the orchestrator needs to recreate this worktree/checkout" >&2
        fi
        echo "ERROR: Git state was corrupt and has been cleaned up. This run will exit; retry to get a fresh worktree." >&2
        exit 1
    fi
fi

# Delegate to base image entrypoint (handles SSH setup, then execs $@)
exec /usr/local/bin/docker-entrypoint.sh "$@"
