#!/usr/bin/env bash
# Build and install the Pi Browser Bridge into a Windows VS Code, and allow its proposed browser API in that VS Code's
# argv.json. VS Code must then be quit fully and started again; Reload Window does not reread argv.json.
#
# Usage: scripts/install-vscode-bridge.sh <code.cmd as a WSL path> <argv.json as a WSL path> [ssh alias]
#   Installed VS Code:  ".../Microsoft VS Code/bin/code.cmd"  "/mnt/c/Users/<user>/.vscode/argv.json"
#   Portable VS Code:   ".../VSCode/bin/code.cmd"            ".../VSCode/data/argv.json"
set -euo pipefail

code="${1:?usage: install-vscode-bridge.sh <code.cmd> <argv.json> [ssh alias]}"
argv="${2:?usage: install-vscode-bridge.sh <code.cmd> <argv.json> [ssh alias]}"
alias="${3:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
"$root/scripts/package-vscode-bridge.sh" "$root/.tmp/pi-browser-bridge.vsix" >/dev/null

# Run a bash script from stdin on the target machine's WSL; the remote login shell may be fish.
on_target() { if [[ -z "$alias" ]]; then bash -s -- "$@"; else ssh -o BatchMode=yes "$alias" bash -s -- "$@"; fi; }
vsix="$(on_target <<'EOF'
cd /mnt/c && wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %TEMP%' | tr -d '\r')"
EOF
)/pi-browser-bridge.vsix"
if [[ -z "$alias" ]]; then cp "$root/.tmp/pi-browser-bridge.vsix" "$vsix"; else scp -q "$root/.tmp/pi-browser-bridge.vsix" "$alias:$vsix"; fi

on_target "$code" "$vsix" "$argv" <<'EOF'
set -euo pipefail
cd /mnt/c
# cmd.exe reads stdin, which here is the rest of this script.
/mnt/c/Windows/System32/cmd.exe /c "$(wslpath -w "$1") --install-extension $(wslpath -w "$2") --force" < /dev/null | tr -d '\r' | grep -v DeprecationWarning | grep -v trace-deprecation || true
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
