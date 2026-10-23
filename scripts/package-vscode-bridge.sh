#!/usr/bin/env bash
# Build the Pi Browser Bridge VS Code extension (vscode-browser-bridge/) into a .vsix with its ws dependency.
# Install it with `code --install-extension <vsix>` and add "enable-proposed-api": ["alexshpunt.pi-browser-bridge"]
# to VS Code's argv.json (Preferences: Configure Runtime Arguments), then restart VS Code fully.
#
# Usage: scripts/package-vscode-bridge.sh [output.vsix]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(realpath -m "${1:-$root/.tmp/pi-browser-bridge.vsix}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$root/vscode-browser-bridge/package.json" "$root/vscode-browser-bridge/extension.js" "$root/vscode-browser-bridge/README.md" "$work/"
(cd "$work" && npm install --omit=dev --no-audit --no-fund --silent && npx --yes @vscode/vsce@4.0.0 package --skip-license -o "$out")
echo "Built $out"
