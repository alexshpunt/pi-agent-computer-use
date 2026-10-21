#!/usr/bin/env bash
# Install Playwright's own Firefox build for open_browser {"browser":"firefox"}. It is the build this package's
# playwright-core version expects, downloaded by playwright-core itself into the Windows user's
# %LOCALAPPDATA%\ms-playwright; nothing system-wide changes. Run it again after updating playwright-core.
#
# Usage: scripts/install-firefox.sh local|MACHINE   (MACHINE is a name under "machines" in .pi/computer-use.json)
set -euo pipefail

target="${1:?usage: install-firefox.sh local|MACHINE}"
package="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$target" == local ]]; then
  cd /mnt/c && "/mnt/c/Program Files/nodejs/node.exe" "$(wslpath -w "$package/node_modules/playwright-core/cli.js")" install firefox
  exit
fi

# The machine's Windows Node and the package copy that setup-remote-machine.sh installed there.
read -r ssh node remote < <(node -e '
  const machine = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).machines?.[process.argv[2]];
  if (!machine?.node || !machine?.package) { console.error("No machine with node and package: " + process.argv[2]); process.exit(1); }
  console.log(machine.ssh, machine.node, machine.package);' "$package/.pi/computer-use.json" "$target")
ssh -o BatchMode=yes "$ssh" bash -s -- "$node" "$remote" <<'EOF'
cd /mnt/c && "$1" "$(wslpath -w "$2/node_modules/playwright-core/cli.js")" install firefox
EOF
