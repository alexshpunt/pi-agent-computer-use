#!/usr/bin/env bash
# Prepare another machine (Windows with WSL, reached over SSH) for computer use from this machine:
# copy the CUA runtime, install a portable Windows Node for the browser worker, copy the browser worker,
# and print the `machines` entry for .pi/computer-use.json. Installs only into the remote user's folders.
#
# Usage: scripts/setup-remote-machine.sh SSH_ALIAS RUNTIME_DIR [NAME]
#   RUNTIME_DIR is a local CUA runtime folder containing runtime/cua-driver.exe (for example the configured one).
set -euo pipefail

alias="${1:?usage: setup-remote-machine.sh SSH_ALIAS RUNTIME_DIR [NAME]}"
runtime_dir="${2:?usage: setup-remote-machine.sh SSH_ALIAS RUNTIME_DIR [NAME]}"
name="${3:-$alias}"
node_version="v22.22.2"
package="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$runtime_dir/runtime/cua-driver.exe" ]] || { echo "No runtime/cua-driver.exe in $runtime_dir" >&2; exit 1; }
[[ -d "$package/node_modules/playwright-core" ]] || { echo "Install dependencies first (npm ci)." >&2; exit 1; }
ssh=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$alias")

# The remote login shell may be fish: run every remote script through bash.
remote_home="$("${ssh[@]}" bash -s <<<'printf %s "$HOME"')"
windows_user="$("${ssh[@]}" bash -s <<'REMOTE'
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command '$env:USERNAME' </dev/null | tr -d '\r'
REMOTE
)"
programs="/mnt/c/Users/$windows_user/AppData/Local/Programs/PiComputerUse"
runtime_name="$(basename "$runtime_dir")"
remote_package="$remote_home/.local/share/pi-computer-use/package"

"${ssh[@]}" mkdir -p "$programs/$runtime_name" "$remote_package/node_modules"
rsync -rt -e "ssh -o BatchMode=yes" "$runtime_dir/" "$alias:$programs/$runtime_name/"
local_hash="$(sha256sum "$runtime_dir/runtime/cua-driver.exe" | cut -d' ' -f1)"
remote_hash="$("${ssh[@]}" sha256sum "$programs/$runtime_name/runtime/cua-driver.exe" | cut -d' ' -f1)"
[[ "$local_hash" == "$remote_hash" ]] || { echo "Runtime copy does not match ($remote_hash)." >&2; exit 1; }

"${ssh[@]}" bash -s -- "$programs" "$node_version" <<'REMOTE'
set -euo pipefail
programs="$1"; version="$2"; zip="node-$version-win-x64.zip"
[[ -x "$programs/node-$version-win-x64/node.exe" ]] && exit 0
cd "$(mktemp -d)"
curl -fsSL -o "$zip" "https://nodejs.org/dist/$version/$zip"
curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" | grep " $zip\$" | sha256sum -c --quiet
python3 -c "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$zip" "$programs"
REMOTE

# The browser worker needs only its own source and playwright-core.
rsync -rt --delete -e "ssh -o BatchMode=yes" "$package/src/" "$alias:$remote_package/src/"
rsync -rt --delete -e "ssh -o BatchMode=yes" "$package/node_modules/playwright-core/" "$alias:$remote_package/node_modules/playwright-core/"
rsync -t -e "ssh -o BatchMode=yes" "$package/package.json" "$alias:$remote_package/package.json"

cat <<JSON
Add to "machines" in .pi/computer-use.json:
"$name": {
  "ssh": "$alias",
  "runtime": "windows-desktop",
  "command": "$programs/$runtime_name/runtime/cua-driver.exe",
  "node": "$programs/node-$node_version-win-x64/node.exe",
  "package": "$remote_package"
}
JSON
