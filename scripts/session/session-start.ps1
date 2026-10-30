# Runs inside an isolated agent session (MXC isolation_session) from its shared workspace. Starts the CUA driver
# with its loopback HTTP endpoint and the window identity bridge, then keeps spare connections dialled out to the
# authenticated Node host relay, each piped to the owned local process. It runs until the session is stopped.
param([Parameter(Mandatory)][string]$Workspace)
$ErrorActionPreference = 'Stop'
. (Join-Path $Workspace 'relay-auth.ps1')
$config = Get-Content -Raw (Join-Path $Workspace 'session.json') | ConvertFrom-Json
# Isolated sessions share one loopback among themselves, so each takes free ports rather than fixed ones.
function Get-FreePort { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop(); $port }
$driverPort = Get-FreePort
$identityPort = Get-FreePort
$env:CUA_DRIVER_RS_MCP_HTTP_PORT = [string]$driverPort
$env:CUA_DRIVER_RS_MCP_HTTP_TOKEN = $config.token
$env:CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false'
$env:CUA_DRIVER_RS_UPDATE_CHECK = 'false'
$env:DO_NOT_TRACK = '1'
$env:CUA_DRIVER_ALLOW_DEBUGGING_LAUNCH = '1'
$out = Join-Path $Workspace 'out'
New-Item -ItemType Directory -Force $out | Out-Null
# No cursor overlay: the session has no desktop compositor, so the overlay window would paint over every capture.
# Named pipes are shared by all sessions, so each session's driver takes its own daemon pipe.
$pipe = '\\.\pipe\cua-driver-' + $env:USERNAME
$driver = Start-Process -PassThru -FilePath (Join-Path $Workspace 'runtime\cua-driver.exe') -ArgumentList 'serve', '--no-overlay', '--socket', $pipe -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $out 'driver.out') -RedirectStandardError (Join-Path $out 'driver.err')
$identity = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1} -Peer "{2}"' -f `
  (Join-Path $Workspace 'guest-identity-bridge.ps1'), $identityPort, (Join-Path $Workspace 'window-identity.ps1'))

# Each channel maps a host session port to a local port inside this session.
$channels = @(@{ host = $config.hostDriverPort; local = $driverPort; name = 'driver'; pid = $driver.Id },
  @{ host = $config.hostIdentityPort; local = $identityPort; name = 'identity'; pid = $identity.Id })
$pairs = [Collections.Generic.List[object]]::new()
while ($true) {
  foreach ($channel in $channels) {
    # Two spare connections per channel; a used one is replaced as soon as it closes.
    while (@($pairs | Where-Object { $_.channel -eq $channel.host }).Count -lt 2) {
      $local = $null; $remote = $null
      try {
        # Authenticate the host before connecting or forwarding any local application bytes.
        $remote = Connect-PiRelay $channel.host $config.relay $channel.name
        $local = [Net.Sockets.TcpClient]::new('127.0.0.1', $channel.local)
        # A sibling can race Get-FreePort. Check the already-established connection's server process before forwarding.
        $owner = Get-NetTCPConnection -State Established -LocalAddress '127.0.0.1' -LocalPort $channel.local `
          -RemoteAddress '127.0.0.1' -RemotePort $local.Client.LocalEndPoint.Port -OwningProcess $channel.pid -ErrorAction SilentlyContinue
        if (-not $owner) { throw 'The local endpoint is not owned by this session worker.' }
        $a = $remote.GetStream(); $b = $local.GetStream()
        $pairs.Add([pscustomobject]@{ channel = $channel.host; h = $remote; l = $local; up = $a.CopyToAsync($b); down = $b.CopyToAsync($a) })
      } catch {
        if ($local) { $local.Close() }
        if ($remote) { $remote.Close() }
        break
      }
    }
  }
  foreach ($p in @($pairs)) { if ($p.up.IsCompleted -or $p.down.IsCompleted) { $p.h.Close(); $p.l.Close(); [void]$pairs.Remove($p) } }
  Start-Sleep -Milliseconds 50
}
