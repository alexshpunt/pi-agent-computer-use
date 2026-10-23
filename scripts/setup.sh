#!/usr/bin/env bash
# One entry point for the optional parts of computer use. /computer-setup runs it; an agent runs it only after the
# user explicitly allowed that install. Run it from the Pi project folder: MACHINE is a name under "machines" in that
# folder's .pi/computer-use.json, and "local" (the default) is this machine.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
package="$(dirname "$here")"

usage() {
  cat <<'EOF'
Usage: setup.sh PART [local|MACHINE]

browser
  Windows Node for open_browser and attach_browser (about 30 MB)
firefox
  Playwright's Firefox for "browser":"firefox" (needs browser)
perception
  Cua perception for the regions view (about 420 MB, AGPL-3.0)
mxc
  Microsoft MXC for open_session (Windows 11 24H2 or later)
vscode-bridge [local|MACHINE] [CODE_CMD ARGV_JSON]
  Pi Browser Bridge for VS Code's integrated browser
machine SSH_ALIAS [NAME]
  Prepare another Windows machine with WSL over SSH

Everything goes into the Windows user's own folders.
EOF
}

# One field of a configured machine; refuse unknown names before any SSH work.
machine_field() {
  node -e '
    const [file, name, field] = process.argv.slice(1);
    let config = {};
    try { config = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch {}
    const machine = config.machines?.[name];
    if (!machine) { console.error(`No machine named ${name} in ${file}.`); process.exit(1); }
    if (!machine[field]) { console.error(`Machine ${name} has no "${field}"; prepare it with: setup.sh machine ${machine.ssh ?? "SSH_ALIAS"} ${name}`); process.exit(1); }
    console.log(machine[field]);' "$PWD/.pi/computer-use.json" "$1" "$2"
}

local_appdata() { (cd /mnt/c && wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %LOCALAPPDATA%' | tr -d '\r')"); }

# The Windows node.exe the browser worker uses here: the portable one from `browser`, else an installed Node.
local_node() {
  local version portable
  version="$(node -p 'require(process.argv[1]).version' "$here/windows-node.json")"
  portable="$(local_appdata)/Programs/PiComputerUse/node-$version-win-x64/node.exe"
  for node_exe in "$portable" "/mnt/c/Program Files/nodejs/node.exe"; do
    [[ -f "$node_exe" ]] && { echo "$node_exe"; return; }
  done
  echo "No Windows Node on this machine; run: setup.sh browser" >&2
  return 1
}

# The driver this machine runs: CUA_DRIVER_PATH, the project's configured command, or the packaged runtime's cache.
local_driver() {
  local configured
  configured="${CUA_DRIVER_PATH:-$(node -e '
    try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).command; if (c) console.log(c); } catch {}' "$PWD/.pi/computer-use.json")}"
  if [[ -n "$configured" ]]; then (cd "$PWD" && realpath -m "$configured"); return; fi
  local source driver
  source="$(node -p 'require(process.argv[1]).source' "$package/src/runtime-pins.json")"
  driver="$(local_appdata)/PiComputerUse/native-runtimes/$source/win32-x64/runtime/cua-driver.exe"
  [[ -f "$driver" ]] || { echo "Computer use has not prepared its runtime yet. Use it once (for example, search for windows), then run this again." >&2; return 1; }
  echo "$driver"
}

playwright_dir() { (cd "$package" && dirname "$(node -p 'require.resolve("playwright-core/package.json")')"); }

component="${1:-}"
shift || true
case "$component" in
  ""|help|-h|--help) usage; exit 0 ;;
  machine)
    alias="${1:?usage: setup.sh machine SSH_ALIAS [NAME]}"
    runtime="$package/native-runtime/win32-x64"
    [[ -f "$runtime/runtime/cua-driver.exe" ]] || { echo "The packaged runtime is not downloaded yet. Use computer use once on this machine, then run this again." >&2; exit 1; }
    playwright="$(playwright_dir)"
    exec bash "$here/setup-remote-machine.sh" "$alias" "$runtime" "$playwright" "${2:-$alias}" ;;
  browser|firefox|perception|mxc|vscode-bridge) ;;
  *) echo "Unknown component: $component" >&2; usage >&2; exit 2 ;;
esac

target="${1:-local}"
shift || true
ssh=""
[[ "$target" == local ]] || ssh="$(machine_field "$target" ssh)"

case "$component" in
  browser) node_exe="$(bash "$here/install-node.sh" "${ssh:-local}")"; echo "Windows Node ready: $node_exe" ;;
  firefox)
    if [[ -z "$ssh" ]]; then node_exe="$(local_node)"; cli="$(playwright_dir)/cli.js"
    else node_exe="$(machine_field "$target" node)"; cli="$(machine_field "$target" package)/node_modules/playwright-core/cli.js"; fi
    exec bash "$here/install-firefox.sh" "$node_exe" "$cli" $ssh ;;
  perception)
    if [[ -z "$ssh" ]]; then driver="$(local_driver)"; else driver="$(machine_field "$target" command)"; fi
    exec bash "$here/install-perception.sh" "${ssh:-local}" "$driver" ;;
  mxc) exec bash "$here/install-mxc.sh" "${ssh:-local}" ;;
  vscode-bridge) exec bash "$here/install-vscode-bridge.sh" "${ssh:-local}" "$@" ;;
esac
