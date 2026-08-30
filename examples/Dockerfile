# Example Dockerfile demonstrating code-wrapper binary distribution
# This shows how to use py-code-wrapper's bundled binary in a production container

# Python base image with py-code-wrapper
FROM python:3.11-slim

# Install py-code-wrapper which bundles the platform-appropriate binary
RUN pip install --no-cache-dir py-code-wrapper

# Set the binary location for code-wrapper clients
ENV CODE_WRAPPER_BINARY=/usr/local/lib/python3.11/site-packages/code_wrapper/binaries/code-wrapper-linux-x64

# Verify binary is available
RUN ls -la $CODE_WRAPPER_BINARY && $CODE_WRAPPER_BINARY --version

# Install your application
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app /app
WORKDIR /app

# Set environment for code-wrapper clients
ENV CLAUDE_CODE_OAUTH_TOKEN=""
ENV ANTHROPIC_API_KEY=""

ENTRYPOINT ["python", "app.py"]
