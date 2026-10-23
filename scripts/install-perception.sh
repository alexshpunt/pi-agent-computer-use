#!/usr/bin/env bash
# Install Cua's signed perception extension (OmniParser v2 icons, PP-OCRv5 text) for the `regions` Read view.
# The release files are checked against pinned SHA-256 sums; the driver then verifies Cua's catalog signature and
# every hash, and installs into the Windows user's %USERPROFILE%\.cua-driver\extensions. About 420 MB; the icon
# detector is AGPL-3.0. Nothing is bundled in this package. scripts/setup.sh perception resolves the arguments.
#
# Usage: scripts/install-perception.sh local|SSH_ALIAS DRIVER_EXE
#   DRIVER_EXE is that machine's WSL path to cua-driver.exe.
set -euo pipefail

target="${1:?usage: install-perception.sh local|SSH_ALIAS DRIVER_EXE}"
driver="${2:?usage: install-perception.sh local|SSH_ALIAS DRIVER_EXE}"
release="https://github.com/trycua/cua/releases/download/cua-perception-v0.2.1"
name="cua-perception-0.2.1-x86_64-pc-windows-msvc"

# Run a bash script from stdin on the target machine's WSL; the remote login shell may be fish.
on_target() { if [[ "$target" == local ]]; then bash -s -- "$@"; else ssh -o BatchMode=yes "$target" bash -s -- "$@"; fi; }

# An installed extension only re-runs its self-test; nothing is downloaded again.
if on_target "$driver" <<<'cd /mnt/c && "$1" extension status perception | grep -q "Active version: 0.2.1"'; then
  on_target "$driver" <<<'cd /mnt/c && "$1" extension status perception --self-test'
  exit
fi

download="$(mktemp -d)"
trap 'rm -rf "$download"' EXIT
curl -fsSL -o "$download/$name.catalog.json" "$release/$name.catalog.json"
curl -fSL --progress-bar -o "$download/$name.tar.gz" "$release/$name.tar.gz"
(cd "$download" && sha256sum -c --quiet) <<EOF
bfb2300ff9da054d522e73351f7b337ba6157ebbe30f029a95a471fc3d13a042  $name.catalog.json
6709579aa3f938e8200c0a51b1abe450d4fda51b09e97517e0cb4c272b5bff37  $name.tar.gz
EOF

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
"$1" extension install perception --catalog "$(wslpath -w "$2/$3.catalog.json")"
"$1" extension status perception --self-test
EOF
