# Getting Started: Binary Distribution

This guide helps you quickly deploy the `code-wrapper` binary to your environment without installing Node.js.

## Choose Your Environment

### 1. Python Application or Docker

Use `py-code-wrapper` — the easiest option with automatic binary bundling.

```bash
# Install
pip install py-code-wrapper

# Use in Python
from code_wrapper import CodeWrapper, ClientOptions

async def main():
    options = ClientOptions(cwd="/work", prompt="Hello")
    client = CodeWrapper()
    async for event in client.run(options):
        print(event)
```

**In Docker:**
```dockerfile
FROM python:3.11-slim
RUN pip install py-code-wrapper
# Binary is ready to use at:
# /usr/local/lib/python3.11/site-packages/code_wrapper/binaries/code-wrapper-linux-x64
```

👉 **See:** [Python Package Documentation](../py-code-wrapper/README.md)

### 2. Fleet Hosts (Ansible)

Deploy to Ansible-managed servers with version pinning.

```bash
# Copy role to your roles directory
cp -r examples/ansible-role-code-wrapper roles/code-wrapper

# Use in playbook
- hosts: fleet
  roles:
    - code-wrapper
  vars:
    code_wrapper_version: v0.1.0
```

👉 **See:** [Ansible Role Setup](../examples/README.md#ansible)

### 3. Manual/Direct Download

Download the binary directly from GitHub Releases.

```bash
# Download for your platform
VERSION=v0.1.0
PLATFORM=linux-x64  # or linux-arm64, darwin-x64, darwin-arm64
wget https://github.com/tinkermonkey/code-wrapper/releases/download/$VERSION/code-wrapper-$PLATFORM
chmod +x code-wrapper-$PLATFORM

# Run it
./code-wrapper-$PLATFORM --version
```

👉 **See:** [Manual Deployment](./DISTRIBUTION.md#github-releases-primary)

## What You Get

The `code-wrapper` binary provides:

- **NDJSON wire protocol** on stdout
- **Session management** across turns
- **Stale session recovery** with automatic retry
- **Extended thinking** content from Claude
- **Tool use** and execution with full results
- **Progress events** every 5 seconds
- **Rate limit handling** with retry detection
- **Platform-specific binaries** for 4 architectures

No Node.js installation needed — it's fully self-contained.

## Verify Installation

### Python Package

```bash
# Check binary location
python -c "from code_wrapper import resolve_binary; print(resolve_binary())"

# Test it works
python -c "import subprocess; b = subprocess.run(['/path/to/code-wrapper', '--version'], capture_output=True); print(b.stdout.decode())"
```

### Docker

```bash
docker run my-app python -c "from code_wrapper import resolve_binary; print(resolve_binary())"
docker run my-app /usr/local/bin/code-wrapper --version
```

### Ansible

```bash
ansible fleet -m command -a "which code-wrapper"
ansible fleet -m command -a "code-wrapper --version"
```

### Direct Binary

```bash
./code-wrapper-linux-x64 --version
file ./code-wrapper-linux-x64  # Should show: ELF 64-bit LSB executable
```

## Next Steps

1. **Choose your distribution channel** (Python package, Docker, Ansible, or direct)
2. **Deploy to your environment** using the appropriate guide
3. **Verify binary is available** using the verification steps above
4. **Start using code-wrapper** in your application or infrastructure

## Documentation

| Topic | Link |
|-------|------|
| **Quick Start** | [README.md](../README.md#distribution-phase-4) |
| **All Channels** | [docs/DISTRIBUTION.md](./DISTRIBUTION.md) |
| **Docker Examples** | [examples/README.md](../examples/README.md#docker) |
| **Ansible Examples** | [examples/README.md](../examples/README.md#ansible) |
| **Binary Protocol** | [docs/EXEC_BINARY.md](../EXEC_BINARY.md) |
| **Python API** | [py-code-wrapper/README.md](../py-code-wrapper/README.md) |

## Common Tasks

### Update Binary Version

**Docker:**
```dockerfile
# Update to new version
RUN pip install --upgrade py-code-wrapper
```

**Ansible:**
```bash
ansible-playbook examples/deploy-code-wrapper.yml -e code_wrapper_version=v0.2.0
```

**Manual:**
```bash
rm code-wrapper-linux-x64
wget https://github.com/tinkermonkey/code-wrapper/releases/download/v0.2.0/code-wrapper-linux-x64
chmod +x code-wrapper-linux-x64
```

### Pin Version Long-Term

**Docker (docker-compose.yml):**
```yaml
services:
  app:
    build:
      args:
        - BINARY_VERSION=v0.1.0
        - BINARY_PLATFORM=linux-x64
```

**Ansible (group_vars/production.yml):**
```yaml
code_wrapper_version: "v0.1.0"
```

**Python (requirements.txt):**
```
py-code-wrapper==0.1.0
```

### Check Current Version

```bash
# Via file (Ansible)
cat /usr/local/bin/code-wrapper.version

# Via binary info (all platforms)
file /path/to/code-wrapper

# Via Python package
pip show py-code-wrapper
```

## Troubleshooting

**Binary not found:**
```bash
# Check environment variable
echo $CODE_WRAPPER_BINARY

# Check PATH
which code-wrapper

# Check Python package
python -c "from code_wrapper import resolve_binary; print(resolve_binary())"
```

**Binary won't execute:**
```bash
# Check permissions
ls -la /path/to/code-wrapper
chmod +x /path/to/code-wrapper

# Check format
file /path/to/code-wrapper  # Should be ELF or Mach-O

# Check dependencies
ldd /path/to/code-wrapper
```

**Platform mismatch:**
```bash
# Check your architecture
uname -m    # x86_64 → linux-x64, aarch64 → linux-arm64
uname -s    # Linux, Darwin

# Download correct platform
VERSION=v0.1.0
PLATFORM=linux-arm64  # Use the right platform!
wget https://github.com/tinkermonkey/code-wrapper/releases/download/$VERSION/code-wrapper-$PLATFORM
```

## Support

- 📖 **Documentation:** [docs/DISTRIBUTION.md](./DISTRIBUTION.md)
- 🐛 **Issues:** [GitHub Issues](https://github.com/tinkermonkey/code-wrapper/issues)
- 💬 **Discussions:** [GitHub Discussions](https://github.com/tinkermonkey/code-wrapper/discussions)

## What's Next

Once you have the binary deployed:

1. **Authenticate** — Set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
2. **Use in your app** — Import `CodeWrapper` (Python) or spawn `code-wrapper` (CLI)
3. **Monitor** — Check logs for errors and track token usage
4. **Update** — Pin versions and update on release schedule

See [py-code-wrapper README](../py-code-wrapper/README.md) for API examples.
