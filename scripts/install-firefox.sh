#!/usr/bin/env bash
# Install Playwright's own Firefox build for open_browser {"browser":"firefox"}. It is the build this package's
# playwright-core version expects, downloaded by playwright-core itself into the Windows user's
# %LOCALAPPDATA%\ms-playwright; nothing system-wide changes. Run it again after updating playwright-core.
# scripts/setup.sh firefox resolves the arguments.
#
# Usage: scripts/install-firefox.sh NODE_EXE PLAYWRIGHT_CLI [SSH_ALIAS]
#   NODE_EXE and PLAYWRIGHT_CLI are WSL paths on the target machine: Windows node.exe and playwright-core's cli.js.
set -euo pipefail

node_exe="${1:?usage: install-firefox.sh NODE_EXE PLAYWRIGHT_CLI [SSH_ALIAS]}"
cli="${2:?usage: install-firefox.sh NODE_EXE PLAYWRIGHT_CLI [SSH_ALIAS]}"
alias="${3:-}"

install='cd /mnt/c && "$1" "$(wslpath -w "$2")" install firefox'
if [[ -z "$alias" ]]; then bash -c "$install" _ "$node_exe" "$cli"
else ssh -o BatchMode=yes "$alias" bash -s -- "$node_exe" "$cli" <<<"$install"; fi
