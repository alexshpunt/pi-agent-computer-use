#!/usr/bin/env bash
# Build and install the Pi Browser Bridge into a Windows VS Code, and allow its proposed browser API in that VS Code's
# argv.json. VS Code must then be quit fully and started again; Reload Window does not reread argv.json.
#
# Usage: scripts/install-vscode-bridge.sh local|SSH_ALIAS [CODE_CMD ARGV_JSON]
#   Without paths, an installed VS Code is found on the target: its bin/code.cmd and %USERPROFILE%\.vscode\argv.json.
#   For a portable VS Code, pass both as WSL paths on the target: ".../VSCode/bin/code.cmd" ".../VSCode/data/argv.json".
set -euo pipefail

target="${1:?usage: install-vscode-bridge.sh local|SSH_ALIAS [CODE_CMD ARGV_JSON]}"
code="${2:-}"
argv="${3:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
bash "$root/scripts/package-vscode-bridge.sh" "$build/pi-browser-bridge.vsix" >/dev/null

# Run a bash script from stdin on the target machine's WSL; the remote login shell may be fish.
on_target() { if [[ "$target" == local ]]; then bash -s -- "$@"; else ssh -o BatchMode=yes "$target" bash -s -- "$@"; fi; }

if [[ -z "$code" || -z "$argv" ]]; then
  read -r -d '' found < <(on_target <<'EOF'
cd /mnt/c
win() { wslpath "$(/mnt/c/Windows/System32/cmd.exe /c "echo %$1%" | tr -d '\r')"; }
for code in "$(win LOCALAPPDATA)/Programs/Microsoft VS Code/bin/code.cmd" "/mnt/c/Program Files/Microsoft VS Code/bin/code.cmd"; do
  [[ -f "$code" ]] && { printf '%s\n%s\n' "$code" "$(win USERPROFILE)/.vscode/argv.json"; exit; }
done
EOF
  ) || true
  code="$(sed -n 1p <<<"$found")"; argv="$(sed -n 2p <<<"$found")"
  [[ -n "$code" ]] || { echo "No installed VS Code found on $target. For a portable one, pass its bin/code.cmd and data/argv.json." >&2; exit 1; }
fi

vsix="$(on_target <<'EOF'
cd /mnt/c && wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %TEMP%' | tr -d '\r')"
EOF
)/pi-browser-bridge.vsix"
if [[ "$target" == local ]]; then cp "$build/pi-browser-bridge.vsix" "$vsix"; else scp -q "$build/pi-browser-bridge.vsix" "$target:$vsix"; fi

on_target "$code" "$vsix" "$argv" <<'EOF'
set -euo pipefail
cd /mnt/c
# PowerShell quotes paths with spaces; its stdin would otherwise read the rest of this script.
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command "& '$(wslpath -w "$1")' --install-extension '$(wslpath -w "$2")' --force" < /dev/null \
  | tr -d '\r' | grep -v -e DeprecationWarning -e trace-deprecation || true
rm -f "$2"
# argv.json is JSONC with comments: add the id to an existing enable-proposed-api list, or insert the key after the
# opening brace, and never rewrite the rest of the file.
python3 - "$3" <<'P'
import json, re, sys
path, ext = sys.argv[1], "alexshpunt.pi-browser-bridge"
try: text = open(path, encoding="utf-8").read()
except FileNotFoundError: text = "{\n}\n"
if ext in text: print(f"{path} already allows {ext}"); sys.exit()
match = re.search(r'"enable-proposed-api"\s*:\s*\[', text)
def empty(rest, close):
    # Whether only whitespace and comments come before the closing bracket, so no separating comma is needed.
    return re.sub(r'//[^\n]*|/\*.*?\*/|\s', "", rest, flags=re.S).startswith(close)
if match:
    rest = text[match.end():]
    text = text[:match.end()] + json.dumps(ext) + ("" if empty(rest, "]") else ", ") + rest
else:
    brace = text.index("{") + 1
    rest = text[brace:]
    text = text[:brace] + f'\n\t"enable-proposed-api": [{json.dumps(ext)}]' + ("" if empty(rest, "}") else ",") + rest
open(path, "w", encoding="utf-8").write(text)
print(f"{path} now allows {ext}")
P
EOF
echo "Installed. Quit VS Code fully and start it again."
