#!/usr/bin/env bash
# Prepare another machine (Windows with WSL, reached over SSH) for computer use from this machine:
# copy the CUA runtime, install a portable Windows Node for the browser worker, copy the browser worker,
# and print the `machines` entry for .pi/computer-use.json. Installs only into the remote user's folders.
# scripts/setup.sh machine resolves the arguments.
#
# Usage: scripts/setup-remote-machine.sh SSH_ALIAS RUNTIME_DIR PLAYWRIGHT_DIR [NAME]
#   RUNTIME_DIR is a local CUA runtime folder containing runtime/cua-driver.exe; PLAYWRIGHT_DIR is playwright-core.
set -euo pipefail

usage="usage: setup-remote-machine.sh SSH_ALIAS RUNTIME_DIR PLAYWRIGHT_DIR [NAME]"
alias="${1:?$usage}"
runtime_dir="${2:?$usage}"
playwright="${3:?$usage}"
name="${4:-$alias}"
here="$(cd "$(dirname "$0")" && pwd)"
package="$(dirname "$here")"
[[ -f "$runtime_dir/runtime/cua-driver.exe" ]] || { echo "No runtime/cua-driver.exe in $runtime_dir" >&2; exit 1; }
[[ -f "$playwright/cli.js" ]] || { echo "No playwright-core in $playwright" >&2; exit 1; }
ssh=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$alias")

# The remote login shell may be fish: run every remote script through bash.
remote_home="$("${ssh[@]}" bash -s <<<'printf %s "$HOME"')"
programs="$("${ssh[@]}" bash -s <<'REMOTE'
cd /mnt/c && wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %LOCALAPPDATA%' | tr -d '\r')"
REMOTE
)/Programs/PiComputerUse"
runtime_name="$(basename "$runtime_dir")"
remote_package="$remote_home/.local/share/pi-computer-use/package"

"${ssh[@]}" mkdir -p "$programs/$runtime_name" "$remote_package/node_modules"
rsync -rt -e "ssh -o BatchMode=yes" "$runtime_dir/" "$alias:$programs/$runtime_name/"
local_hash="$(sha256sum "$runtime_dir/runtime/cua-driver.exe" | cut -d' ' -f1)"
remote_hash="$("${ssh[@]}" sha256sum "$programs/$runtime_name/runtime/cua-driver.exe" | cut -d' ' -f1)"
[[ "$local_hash" == "$remote_hash" ]] || { echo "Runtime copy does not match ($remote_hash)." >&2; exit 1; }

node_exe="$(bash "$here/install-node.sh" "$alias")"

# The browser worker needs only its own source and playwright-core.
rsync -rt --delete -e "ssh -o BatchMode=yes" "$package/src/" "$alias:$remote_package/src/"
rsync -rt --delete -e "ssh -o BatchMode=yes" "$playwright/" "$alias:$remote_package/node_modules/playwright-core/"
rsync -t -e "ssh -o BatchMode=yes" "$package/package.json" "$alias:$remote_package/package.json"

cat <<JSON
Add to "machines" in .pi/computer-use.json:
"$name": {
  "ssh": "$alias",
  "runtime": "windows-desktop",
  "command": "$programs/$runtime_name/runtime/cua-driver.exe",
  "node": "$node_exe",
  "package": "$remote_package"
}
JSON
