#!/bin/bash
set -e

# Build standalone binaries for all supported platforms
# Requires: bun with --compile support

echo "Building code-wrapper binaries..."

TARGETS=(
  "bun-linux-x64:dist/code-wrapper-linux-x64"
  "bun-linux-arm64:dist/code-wrapper-linux-arm64"
  "bun-darwin-x64:dist/code-wrapper-darwin-x64"
  "bun-darwin-arm64:dist/code-wrapper-darwin-arm64"
)

for target in "${TARGETS[@]}"; do
  IFS=":" read -r platform outfile <<< "$target"
  echo "Building $platform -> $outfile"
  bun build --compile --target="$platform" src/cli/exec.ts --outfile "$outfile"
  chmod +x "$outfile"
done

echo "Done! Binaries:"
ls -lh dist/code-wrapper-*
