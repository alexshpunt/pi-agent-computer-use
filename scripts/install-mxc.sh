#!/usr/bin/env bash
# Install wxc-exec.exe from Microsoft Execution Containers (MXC, MIT) for open_session: isolated Windows agent
# sessions. It goes into the Windows user's %LOCALAPPDATA%\PiComputerUse\mxc; nothing system-wide changes. Session
# isolation needs Windows 11 24H2/25H2 build 9550 or later; provisioning reports it otherwise.
#
# Usage: scripts/install-mxc.sh local|SSH_ALIAS
set -euo pipefail

target="${1:?usage: install-mxc.sh local|SSH_ALIAS}"
release="v1.0.1"
sha256="0e832239454ba7fcd338ff56218a287eef4c0a01c1484084b869f55feff8abe9"

# Run a bash script from stdin on the target machine's WSL; the remote login shell may be fish.
on_target() { if [[ "$target" == local ]]; then bash -s -- "$@"; else ssh -o BatchMode=yes "$target" bash -s -- "$@"; fi; }

download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
curl -fsSL -o "$download/mxc-release-binaries.zip" "https://github.com/microsoft/mxc/releases/download/$release/mxc-release-binaries.zip"
echo "$sha256  $download/mxc-release-binaries.zip" | sha256sum -c --quiet
python3 -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extract('x64/wxc-exec.exe', sys.argv[2])" "$download/mxc-release-binaries.zip" "$download"

folder="$(on_target <<'EOF'
cd /mnt/c && wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %LOCALAPPDATA%' | tr -d '\r')"
EOF
)/PiComputerUse/mxc"
on_target "$folder" <<<'mkdir -p "$1"'
if [[ "$target" == local ]]; then cp "$download/x64/wxc-exec.exe" "$folder/"
else rsync -t "$download/x64/wxc-exec.exe" "$target:$folder/"; fi
echo "Installed MXC $release wxc-exec.exe in $folder"
