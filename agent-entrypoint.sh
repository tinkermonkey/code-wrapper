#!/bin/sh
set -e

# Resolve GitHub token from either env var name (GH_TOKEN takes precedence in gh CLI)
RESOLVED_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"

if [ -n "$RESOLVED_TOKEN" ]; then
    export GH_TOKEN="$RESOLVED_TOKEN"
    export GITHUB_TOKEN="$RESOLVED_TOKEN"

    # Write hosts.yml directly so gh never falls back to keyring/D-Bus
    mkdir -p "${HOME}/.config/gh"
    cat > "${HOME}/.config/gh/hosts.yml" <<EOF
github.com:
    oauth_token: ${RESOLVED_TOKEN}
    git_protocol: https
EOF
    chmod 600 "${HOME}/.config/gh/hosts.yml"
fi

# Delegate to base image entrypoint (handles SSH setup, then execs $@)
exec /usr/local/bin/docker-entrypoint.sh "$@"
