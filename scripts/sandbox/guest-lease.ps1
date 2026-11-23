# Runs in the Windows Sandbox guest user session: serve the shared input lease (guest-lease.cs) on all interfaces, and
# with zones on, keep each agent's windows in its screen zone (guest-zones.cs).
# It needs the user's desktop to read the foreground thread's menu state, to release stuck buttons and keys, and to
# move the agents' windows.
# Zones run only when the agent that started the sandbox turned them on (zones.txt says on).
param([int]$Port = 47803, [string]$TokenFile = 'C:\pi\config\token.txt', [int]$StickyMs = 15000, [string]$ZonesFile = 'C:\pi\config\zones.txt')
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'guest-lease.cs'), (Join-Path $PSScriptRoot 'guest-zones.cs')
$zones = (Test-Path -LiteralPath $ZonesFile) -and (Get-Content -Raw -LiteralPath $ZonesFile).Trim() -eq 'on'
[PiInputLease]::Run($Port, (Get-Content -Raw -LiteralPath $TokenFile).Trim(), $StickyMs, $zones)
