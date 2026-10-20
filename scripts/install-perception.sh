#!/usr/bin/env bash
# Install Cua's signed perception extension (OmniParser v2 icons, PP-OCRv5 text) for the `regions` Read view.
# The driver verifies Cua's catalog signature and every hash, and installs into the Windows user's
# %USERPROFILE%\.cua-driver\extensions. Nothing is bundled in this package.
#
# Usage: scripts/install-perception.sh local|SSH_ALIAS DRIVER_EXE
#   DRIVER_EXE is that machine's WSL path to cua-driver.exe (the configured `command`).
set -euo pipefail

target="${1:?usage: install-perception.sh local|SSH_ALIAS DRIVER_EXE}"
driver="${2:?usage: install-perception.sh local|SSH_ALIAS DRIVER_EXE}"
name="cua-perception-0.2.1-x86_64-pc-windows-msvc"

# Run a bash script from stdin on the target machine's WSL; the remote login shell may be fish.
on_target() { if [[ "$target" == local ]]; then bash -s -- "$@"; else ssh -o BatchMode=yes "$target" bash -s -- "$@"; fi; }

download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
gh release download cua-perception-v0.2.1 -R trycua/cua -D "$download" -p "$name.catalog.json" -p "$name.tar.gz" -p SHA256SUMS
(cd "$download" && grep -E " $name\.(catalog\.json|tar\.gz)\$" SHA256SUMS | sha256sum -c --quiet)

# The catalog names its archive beside it, in the target's Windows temp folder.
temp="$(on_target <<'EOF'
cd /mnt/c && wslpath "$(/mnt/c/Windows/System32/cmd.exe /c 'echo %TEMP%' | tr -d '\r')"
EOF
)/pi-perception"
on_target "$temp" <<<'mkdir -p "$1"'
if [[ "$target" == local ]]; then cp "$download/$name".{catalog.json,tar.gz} "$temp/"
else rsync -t --partial "$download/$name".{catalog.json,tar.gz} "$target:$temp/"; fi

on_target "$driver" "$temp" "$name" <<'EOF'
set -euo pipefail
trap 'cd / && rm -rf "$2"' EXIT
cd "$2"
"$1" extension status perception | grep -q "Active version: 0.2.1" ||
  "$1" extension install perception --catalog "$(wslpath -w "$2/$3.catalog.json")"
"$1" extension status perception --self-test
EOF
