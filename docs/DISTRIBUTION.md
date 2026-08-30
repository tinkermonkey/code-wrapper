# code-wrapper Binary Distribution

This document covers how to distribute and deploy the `code-wrapper` compiled binary to production environments (fleet hosts, Docker containers, and other deployment targets).

## Overview

The `code-wrapper` binary is compiled from TypeScript using Bun's `--compile` feature, producing platform-specific standalone executables that require **no Node.js runtime** on the host.

Platform support:
- **linux-x64**: AMD64 / x86_64 systems
- **linux-arm64**: ARM64 / aarch64 systems (including AWS Graviton)
- **darwin-x64**: macOS Intel
- **darwin-arm64**: macOS Apple Silicon (M1+)

## Channels

### 1. GitHub Releases (Primary)

The official release channel for all platform-specific binaries.

**Format:**
- Tagged release per version (e.g., `v0.1.0`)
- Each release contains four platform-specific binaries as assets:
  - `code-wrapper-linux-x64`
  - `code-wrapper-linux-arm64`
  - `code-wrapper-darwin-x64`
  - `code-wrapper-darwin-arm64`

**Automation:**
- Triggered on every version tag (`v*`)
- Compiled and published by `.github/workflows/release-binaries.yml`

**Manual download:**
```bash
# Download a specific version's binaries
VERSION=v0.1.0
PLATFORM=linux-x64  # or linux-arm64, darwin-x64, darwin-arm64
wget https://github.com/tinkermonkey/code-wrapper/releases/download/$VERSION/code-wrapper-$PLATFORM
chmod +x code-wrapper-$PLATFORM
```

### 2. Python Package (py-code-wrapper)

The `py-code-wrapper` Python package bundles the platform-appropriate binary for the installing host.

**Installation:**
```bash
pip install py-code-wrapper
```

**How it works:**
1. During `pip install`, the package's `setup.py` runs a download script
2. The script fetches the latest release from GitHub
3. The PyPI-distributed wheel includes all four platform binaries for universal deployment
4. When installed, `code_wrapper.resolve_binary()` finds the matching binary for the current platform

**Binary resolution order:**
1. `CODE_WRAPPER_BINARY` environment variable (if set)
2. `code-wrapper` in PATH
3. Platform-bundled binary in the package (`code_wrapper/binaries/code-wrapper-{os}-{arch}`)

**Supported Python versions:** 3.9+

## Docker

### Base Image Setup

To include the `code-wrapper` binary in a Docker image without requiring Node.js or `npm`:

```dockerfile
# Use any base image you need (Python, Alpine, Ubuntu, etc.)
FROM python:3.11-slim

# Install py-code-wrapper with bundled binary
RUN pip install py-code-wrapper

# Code wrapper is now available at:
# /usr/local/lib/python3.11/site-packages/code_wrapper/binaries/code-wrapper-linux-x64

# Example: Create a symlink to a standard location
RUN ln -s /usr/local/lib/python3.11/site-packages/code_wrapper/binaries/code-wrapper-linux-x64 /usr/local/bin/code-wrapper

# Or use CODE_WRAPPER_BINARY environment variable
ENV CODE_WRAPPER_BINARY=/usr/local/lib/python3.11/site-packages/code_wrapper/binaries/code-wrapper-linux-x64

# Your application code
COPY app /app
WORKDIR /app

# Run your Python application that uses code-wrapper
CMD ["python", "app.py"]
```

### Multi-Stage Build (Optional)

If you need a minimal production image without Python development tools:

```dockerfile
# Build stage
FROM python:3.11-slim as builder
RUN pip install py-code-wrapper
RUN find /usr/local/lib/python3.11/site-packages/code_wrapper/binaries -type f -executable

# Production stage
FROM python:3.11-slim
# Copy only the binary and runtime dependencies
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
RUN pip install --no-cache-dir pydantic typing-extensions

COPY app /app
WORKDIR /app
CMD ["python", "app.py"]
```

### Direct Binary Copy

If you prefer to fetch and copy the binary directly (without Python packaging):

```dockerfile
FROM ubuntu:22.04

# Download specific binary version
ARG BINARY_VERSION=v0.1.0
ARG BINARY_PLATFORM=linux-x64
RUN apt-get update && apt-get install -y wget && rm -rf /var/lib/apt/lists/*
RUN wget -O /usr/local/bin/code-wrapper \
    https://github.com/tinkermonkey/code-wrapper/releases/download/$BINARY_VERSION/code-wrapper-$BINARY_PLATFORM && \
    chmod +x /usr/local/bin/code-wrapper

# Your application
COPY app /app
WORKDIR /app
CMD ["/app/entrypoint.sh"]
```

**Build with specific binary version:**
```bash
docker build \
  --build-arg BINARY_VERSION=v0.1.0 \
  --build-arg BINARY_PLATFORM=linux-x64 \
  -t my-app:latest .
```

## Ansible

### Fleet Host Distribution

Deploy the `code-wrapper` binary to Ansible-managed fleet hosts with version pinning.

#### Role Structure

```
roles/code-wrapper/
├── defaults/
│   └── main.yml          # Default binary version and platforms
├── tasks/
│   └── main.yml          # Download and install binary
├── templates/
│   └── code-wrapper-env.j2
└── handlers/
    └── main.yml          # Service restart handlers (if applicable)
```

#### Role Implementation

**`roles/code-wrapper/defaults/main.yml`:**
```yaml
# Code-wrapper binary version to deploy
code_wrapper_version: "v0.1.0"

# Installation directory (must be in PATH or set CODE_WRAPPER_BINARY)
code_wrapper_install_dir: /usr/local/bin

# Download retry settings
code_wrapper_download_retries: 3
code_wrapper_download_timeout: 300

# User/group for binary ownership
code_wrapper_owner: root
code_wrapper_group: root
code_wrapper_mode: "0755"

# Optional: restrict to specific platforms (empty = all)
code_wrapper_platforms: []  # e.g., ["linux-x64", "linux-arm64"]
```

**`roles/code-wrapper/tasks/main.yml`:**
```yaml
---
- name: Detect target platform
  set_fact:
    _platform: "{{ ansible_system | lower }}-{{ 'x64' if ansible_architecture == 'x86_64' else 'arm64' if ansible_architecture == 'aarch64' else ansible_architecture }}"

- name: Validate platform support
  fail:
    msg: "Unsupported platform: {{ _platform }}"
  when: _platform not in ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']

- name: Download code-wrapper binary
  get_url:
    url: "https://github.com/tinkermonkey/code-wrapper/releases/download/{{ code_wrapper_version }}/code-wrapper-{{ _platform }}"
    dest: "{{ code_wrapper_install_dir }}/code-wrapper"
    mode: "{{ code_wrapper_mode }}"
    owner: "{{ code_wrapper_owner }}"
    group: "{{ code_wrapper_group }}"
    backup: yes
    force: yes
    timeout: "{{ code_wrapper_download_timeout }}"
  retries: "{{ code_wrapper_download_retries }}"
  delay: 10
  register: _binary_download

- name: Verify binary is executable
  file:
    path: "{{ code_wrapper_install_dir }}/code-wrapper"
    mode: "{{ code_wrapper_mode }}"

- name: Verify binary runs
  command: "{{ code_wrapper_install_dir }}/code-wrapper --version"
  changed_when: false
  failed_when: false
  register: _version_check

- name: Log version check result
  debug:
    msg: "code-wrapper version check: {{ _version_check.stdout or _version_check.stderr }}"

- name: Create version file for tracking
  copy:
    content: "{{ code_wrapper_version }}"
    dest: "{{ code_wrapper_install_dir }}/code-wrapper.version"
    owner: "{{ code_wrapper_owner }}"
    group: "{{ code_wrapper_group }}"
    mode: "0644"
```

#### Usage in Playbooks

**Deploy to all fleet hosts:**
```yaml
---
- hosts: fleet
  roles:
    - code-wrapper
```

**Deploy specific version to a subset:**
```yaml
---
- hosts: fleet_production
  vars:
    code_wrapper_version: "v0.1.0"
  roles:
    - code-wrapper
  post_tasks:
    - name: Restart services using code-wrapper
      systemd:
        name: "{{ item }}"
        state: restarted
      loop:
        - phone-home
        - rounds
      when: _binary_download.changed
```

**Pinned version with idempotency:**
```yaml
---
- hosts: fleet
  tasks:
    - name: Check current code-wrapper version
      stat:
        path: /usr/local/bin/code-wrapper.version
      register: _version_stat

    - name: Get current version
      slurp:
        src: /usr/local/bin/code-wrapper.version
      register: _current_version
      when: _version_stat.stat.exists

    - name: Deploy code-wrapper if version mismatch
      include_role:
        name: code-wrapper
      vars:
        code_wrapper_version: "v0.1.0"
      when: not _version_stat.stat.exists or _current_version.content | b64decode | trim != "v0.1.0"
```

## CI/CD Integration

### GitHub Actions

The release workflow is triggered automatically:

```yaml
on:
  push:
    tags:
      - 'v*'
```

To create a release:

```bash
# Tag and push
git tag v0.1.0
git push origin v0.1.0

# GitHub Actions automatically:
# 1. Compiles binaries for all four platforms
# 2. Uploads them as release assets
# 3. Creates a GitHub Release
```

### Artifact Distribution

Binaries are published to GitHub Releases at:
```
https://github.com/tinkermonkey/code-wrapper/releases/tag/vX.Y.Z
```

Download URLs follow the pattern:
```
https://github.com/tinkermonkey/code-wrapper/releases/download/vX.Y.Z/code-wrapper-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}
```

## Version Pinning

### For Fleet Hosts

Pin the version in your Ansible group_vars or host_vars:

```yaml
# inventory/group_vars/fleet.yml
code_wrapper_version: "v0.1.0"
```

Rotate versions by updating a single value:

```bash
# Update all fleet hosts to a new version
ansible-playbook -i inventory site.yml \
  -e code_wrapper_version=v0.2.0
```

### For Docker Images

Pin in `docker-compose.yml` or build arguments:

```yaml
# docker-compose.yml
services:
  app:
    build:
      context: .
      args:
        BINARY_VERSION: v0.1.0
        BINARY_PLATFORM: linux-x64
```

### For Python Applications

Pin in `requirements.txt`:

```
# The py-code-wrapper version ensures binary compatibility
py-code-wrapper==0.1.0
```

Or in `pyproject.toml`:

```toml
dependencies = [
    "py-code-wrapper==0.1.0",
]
```

## Troubleshooting

### Binary not found

If `code-wrapper` is not found, check resolution order:

```bash
# 1. Check environment variable
echo $CODE_WRAPPER_BINARY

# 2. Check PATH
which code-wrapper

# 3. Check Python package
python -c "from code_wrapper import resolve_binary; print(resolve_binary())"

# 4. Manual verification
ls -la /usr/local/lib/python3.11/site-packages/code_wrapper/binaries/
```

### Binary is not executable

```bash
# Fix permissions
chmod +x /path/to/code-wrapper

# Or in Ansible:
file:
  path: /usr/local/bin/code-wrapper
  mode: "0755"
```

### Platform mismatch

Ensure the downloaded binary matches the host platform:

```bash
# Check host architecture
uname -m     # x86_64 → x64, aarch64 → arm64
uname -s     # Linux, Darwin

# Verify binary format
file /usr/local/bin/code-wrapper
```

### Version conflicts

Clear old binaries and reinstall:

```bash
# For Python package
pip uninstall py-code-wrapper -y
pip install --no-cache-dir py-code-wrapper

# For Ansible
ansible-playbook -i inventory site.yml --tags code-wrapper --force
```

## Security Considerations

1. **Checksum Verification**
   - GitHub Releases include binary assets; consider adding checksums in release descriptions
   - Use `get_url` in Ansible with `checksum` parameter when available

2. **Build Artifact Verification**
   - Binaries are built by GitHub Actions from tagged commits
   - Review `.github/workflows/release-binaries.yml` to verify build process
   - Consider signing releases with GPG for additional verification

3. **Network Security**
   - Download binaries over HTTPS only
   - Use network policies to restrict binary download sources
   - Cache frequently-deployed versions in private artifact repositories

4. **Binary Execution**
   - Set appropriate file permissions (typically `0755`)
   - Restrict writable access to binary files
   - Consider SELinux contexts on RHEL-based systems

## References

- [code-wrapper Binary Documentation](./EXEC_BINARY.md)
- [py-code-wrapper Package](./py-code-wrapper/README.md)
- [GitHub Releases API](https://docs.github.com/en/rest/releases)
- [Ansible get_url Module](https://docs.ansible.com/ansible/latest/modules/get_url_module.html)
