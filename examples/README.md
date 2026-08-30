# code-wrapper Distribution Examples

This directory contains example configurations for deploying the `code-wrapper` binary to production environments without requiring a Node.js runtime.

## Contents

### Docker Examples

- **`Dockerfile`** — Basic Python 3.11 setup with py-code-wrapper
  - Minimal, demonstrates bundled binary usage
  - Suitable for development and testing

- **`Dockerfile.production`** — Production-ready multi-stage build
  - Optimized for size and security
  - Extracts only necessary binaries
  - Includes health checks
  - Suitable for Kubernetes and cloud deployments

- **`docker-compose.yml`** — Example Docker Compose stack
  - Shows how to configure CODE_WRAPPER_BINARY env var
  - Includes health checks
  - Can be used locally with `docker-compose up`

### Ansible Examples

- **`ansible-role-code-wrapper/`** — Reusable Ansible role
  - `defaults/main.yml` — Configuration defaults
  - `tasks/main.yml` — Role implementation with platform detection
  - Handles:
    - Platform detection (linux-x64, linux-arm64, darwin-x64, darwin-arm64)
    - Binary download from GitHub Releases
    - Version tracking for idempotency
    - Verification of binary functionality

- **`deploy-code-wrapper.yml`** — Example playbook
  - Shows how to use the Ansible role
  - Includes post-deployment verification
  - Demonstrates version pinning and rolling updates

## Quick Start

### Docker

Build and run locally:

```bash
# Using basic Dockerfile
docker build -f Dockerfile -t my-app .
docker run -it my-app

# Using docker-compose
docker-compose up --build

# Using production Dockerfile
docker build -f Dockerfile.production -t my-app:prod .
docker run -it my-app:prod
```

### Ansible

Deploy to fleet hosts:

```bash
# Deploy to all fleet hosts
ansible-playbook deploy-code-wrapper.yml -i inventory/

# Deploy specific version to production
ansible-playbook deploy-code-wrapper.yml \
  -i inventory/production \
  -e code_wrapper_version=v0.1.0

# Check if binary is available
ansible fleet -i inventory/ -m command -a "which code-wrapper"
```

## Usage in Your Application

Once deployed, applications can use code-wrapper via:

### Python

```python
from code_wrapper import CodeWrapper, ClientOptions

async def main():
    options = ClientOptions(
        cwd="/workspace",
        prompt="What is the meaning of life?",
    )
    
    client = CodeWrapper()
    async for event in client.run(options):
        print(f"{event.type}: {event}")
```

### Shell/CLI

```bash
# Binary is available in PATH or via CODE_WRAPPER_BINARY
code-wrapper exec \
  --backend claude \
  --cwd /path/to/project \
  --prompt "Create a README.md file"
```

## Environment Variables

Configure code-wrapper via environment variables:

```bash
# Specify binary location (if not in default paths)
export CODE_WRAPPER_BINARY=/usr/local/bin/code-wrapper

# Set API credentials
export ANTHROPIC_API_KEY=sk-...
export CLAUDE_CODE_OAUTH_TOKEN=...
```

## Binary Locations

After deployment, the binary can be found at:

- **Docker (via py-code-wrapper):**
  `/usr/local/lib/python3.11/site-packages/code_wrapper/binaries/code-wrapper-linux-x64`

- **Docker (direct download):**
  `/usr/local/bin/code-wrapper`

- **Ansible:**
  `/usr/local/bin/code-wrapper`

- **PATH:**
  `code-wrapper` (after adding install dir to PATH)

## Verifying Installation

### Docker

```bash
docker run my-app code-wrapper --version
docker run my-app python -c "from code_wrapper import resolve_binary; print(resolve_binary())"
```

### Ansible

```bash
ansible fleet -i inventory/ -m command -a "code-wrapper --version"
ansible fleet -i inventory/ -m command -a "cat /usr/local/bin/code-wrapper.version"
```

## Troubleshooting

### Binary not found

Check resolution order:

```bash
# Check environment variable
echo $CODE_WRAPPER_BINARY

# Check PATH
which code-wrapper

# Check Python package (Docker)
ls -la /usr/local/lib/python*/site-packages/code_wrapper/binaries/

# Check direct install (Ansible)
ls -la /usr/local/bin/code-wrapper
```

### Verify binary works

```bash
# Direct execution
/usr/local/bin/code-wrapper --version

# Via Python
python -c "from code_wrapper import resolve_binary; print(resolve_binary())"

# Via docker
docker run my-app bash -c "file $(which code-wrapper)"
```

### Platform mismatch

Ensure binary matches host architecture:

```bash
# Check architecture
uname -m  # x86_64 → x64, aarch64 → arm64

# Check binary format
file /usr/local/bin/code-wrapper
# Should show: ELF 64-bit LSB executable

# Re-deploy with correct platform
ansible-playbook deploy-code-wrapper.yml -e code_wrapper_version=v0.1.0 -f 5
```

## Production Considerations

1. **Size optimization**: Use `Dockerfile.production` multi-stage build
2. **Version pinning**: Set `code_wrapper_version` in all deployments
3. **Health checks**: Included in Docker examples
4. **API credentials**: Use secrets management (Docker secrets, Ansible vault)
5. **Updates**: Pin versions; rolling updates via Ansible
6. **Monitoring**: Track binary availability in healthchecks

## Additional Resources

- [Full Distribution Documentation](../docs/DISTRIBUTION.md)
- [Binary Documentation](../EXEC_BINARY.md)
- [py-code-wrapper Package](../py-code-wrapper/README.md)
- [GitHub Releases](https://github.com/tinkermonkey/code-wrapper/releases)
