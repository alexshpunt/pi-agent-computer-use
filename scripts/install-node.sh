#!/usr/bin/env bash
# Install a portable Windows Node for the Playwright browser worker (open_browser and attach_browser) into the
# Windows user's %LOCALAPPDATA%\Programs\PiComputerUse. The version and its SHA-256 are pinned in windows-node.json;
# nothing system-wide changes. Prints the node.exe path as a WSL path.
#
# Usage: scripts/install-node.sh local|SSH_ALIAS
set -euo pipefail

target="${1:?usage: install-node.sh local|SSH_ALIAS}"
here="$(cd "$(dirname "$0")" && pwd)"
read -r version sha256 < <(node -e 'const p = require(process.argv[1]); console.log(p.version, p.sha256)' "$here/windows-node.json")
zip="node-$version-win-x64.zip"

# Run a bash script from stdin on the target machine's WSL; the remote login shell may be fish.
on_target() { if [[ "$target" == local ]]; then bash -s -- "$@"; else ssh -o BatchMode=yes "$target" bash -s -- "$@"; fi; }

programs="$(on_target <<'EOF'
cd /mnt/c && wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %LOCALAPPDATA%' | tr -d '\r')"
EOF
)/Programs/PiComputerUse"
node_exe="$programs/node-$version-win-x64/node.exe"
if on_target "$node_exe" <<<'[[ -f "$1" ]]'; then echo "$node_exe"; exit; fi

download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
curl -fsSL -o "$download/$zip" "https://nodejs.org/dist/$version/$zip"
echo "$sha256  $download/$zip" | sha256sum -c --quiet
python3 -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$download/$zip" "$download/out"
on_target "$programs" <<<'mkdir -p "$1"'
if [[ "$target" == local ]]; then cp -r "$download/out/node-$version-win-x64" "$programs/"
else rsync -rt "$download/out/node-$version-win-x64" "$target:$programs/"; fi
echo "$node_exe"
