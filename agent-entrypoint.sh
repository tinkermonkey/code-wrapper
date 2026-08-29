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

# Delegate to base image entrypoint (handles SSH setup, then execs $@)
exec /usr/local/bin/docker-entrypoint.sh "$@"
