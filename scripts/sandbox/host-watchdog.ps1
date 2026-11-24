# Runs hidden on the Windows host for as long as the shared Windows Sandbox runs. Agents touch their file in agents\
# while they use the sandbox. This stops the sandbox and its relays $IdleSeconds after the last agent left, drops agents
# whose file is older than $StaleSeconds (their Pi ended without leaving), and cleans up when the human closes the
# sandbox. It exits when sandbox.json no longer names its $Key.
param(
  [Parameter(Mandatory)][string]$Dir,
  [Parameter(Mandatory)][string]$Key,
  [int]$IdleSeconds = 600,
  [int]$StaleSeconds = 120
)
$ErrorActionPreference = 'Continue'
$state = Join-Path $Dir 'sandbox.json'
$agents = Join-Path $Dir 'agents'
$lock = Join-Path $Dir 'lock'
$wsb = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wsb.exe'

function Read-State {
  try { Get-Content -Raw -LiteralPath $state -ErrorAction Stop | ConvertFrom-Json } catch { $null }
}

function Stop-Shared($s) {
  & $wsb stop --id $s.id *> $null
  # wsb stop is what stops the VM; closing the sandbox client this sandbox started only removes its window.
  Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime -ge [DateTime]::Parse($s.startedAt).AddSeconds(-5) } | Stop-Process -Force
  foreach ($relay in @($s.relays.driver, $s.relays.identity, $s.relays.lease, $s.relays.stream)) { Stop-Process -Id $relay.pid -Force -ErrorAction SilentlyContinue }
  foreach ($name in 'sandbox.json', 'sandbox.wsb', 'config', 'out', 'agents') {
    Remove-Item -LiteralPath (Join-Path $Dir $name) -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Agents { @(Get-ChildItem -LiteralPath $agents -Filter '*.json' -File -ErrorAction SilentlyContinue) }

$idleSince = $null
while ($true) {
  Start-Sleep -Seconds 10
  $s = Read-State
  if (-not $s -or $s.watchdog.key -ne $Key) { exit }
  if (-not (Get-Process vmmemWindowsSandbox -ErrorAction SilentlyContinue)) {
    # The human closed the sandbox. An agent holding the lock may be starting a new one over this stale state right now
    # and cleans it up itself; deleting the folders under it would break that start.
    try { ([IO.File]::Open($lock, 'CreateNew', 'Write', 'None')).Dispose() } catch { continue }
    try { if ((Read-State).watchdog.key -eq $Key) { Stop-Shared $s } } finally { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
    exit
  }
  $now = [DateTime]::UtcNow
  Agents | Where-Object { $_.LastWriteTimeUtc -lt $now.AddSeconds(-$StaleSeconds) } | Remove-Item -Force -ErrorAction SilentlyContinue
  if ((Agents).Count) { $idleSince = $null; continue }
  if (-not $idleSince) { $idleSince = $now; continue }
  if (($now - $idleSince).TotalSeconds -lt $IdleSeconds) { continue }
  # An agent holding the lock is attaching right now.
  # CreateNew is atomic, unlike New-Item, which checks and then creates.
  try { ([IO.File]::Open($lock, 'CreateNew', 'Write', 'None')).Dispose() } catch { continue }
  try {
    if ((Agents).Count) { $idleSince = $null; continue }
    Stop-Shared $s
    exit
  } finally { Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue }
}
