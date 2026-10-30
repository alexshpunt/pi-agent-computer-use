# Runs in an isolated MXC user session. Driver traffic uses its owned local endpoint; each authenticated
# identity reverse channel owns one marker peer over stdio, with no identity TCP listener.
param([Parameter(Mandatory)][string]$Workspace)
$ErrorActionPreference = 'Stop'
. (Join-Path $Workspace 'relay-auth.ps1')
. (Join-Path $Workspace 'identity-channel.ps1')
$config = Get-Content -Raw (Join-Path $Workspace 'session.json') | ConvertFrom-Json
function Get-FreePort { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $l.Start(); $port = $l.LocalEndpoint.Port; $l.Stop(); $port }
$driverPort = Get-FreePort
$env:CUA_DRIVER_RS_MCP_HTTP_PORT = [string]$driverPort
$env:CUA_DRIVER_RS_MCP_HTTP_TOKEN = $config.token
$env:CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false'
$env:CUA_DRIVER_RS_UPDATE_CHECK = 'false'
$env:DO_NOT_TRACK = '1'
$env:CUA_DRIVER_ALLOW_DEBUGGING_LAUNCH = '1'
$out = Join-Path $Workspace 'out'
New-Item -ItemType Directory -Force $out | Out-Null
# No compositor in this session: an overlay would paint over captures. The daemon pipe is private to this user.
$pipe = '\\.\pipe\cua-driver-' + $env:USERNAME
$driver = Start-Process -PassThru -FilePath (Join-Path $Workspace 'runtime\cua-driver.exe') -ArgumentList 'serve', '--no-overlay', '--socket', $pipe -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $out 'driver.out') -RedirectStandardError (Join-Path $out 'driver.err')
$channels = @(@{ host = $config.hostDriverPort; name = 'driver' }, @{ host = $config.hostIdentityPort; name = 'identity' })
$pairs = [Collections.Generic.List[object]]::new()
function Close-PiSessionPair($Pair) {
  $Pair.h.Close()
  if ($Pair.l) { $Pair.l.Close() }
  if ($Pair.peer) { Stop-PiIdentityPeer $Pair.peer }
  # Observe any failed copy tasks after closing their owned streams.
  $null = $Pair.up.Exception; $null = $Pair.down.Exception
}
try {
  while ($true) {
    foreach ($channel in $channels) {
      # Two spares per authenticated channel. Identity spares have no markers until the controller sends a request.
      while (@($pairs | Where-Object { $_.channel -eq $channel.host }).Count -lt 2) {
        $local = $null; $remote = $null; $peer = $null
        try {
          $remote = Connect-PiRelay $channel.host $config.relay $channel.name
          $a = $remote.GetStream()
          if ($channel.name -eq 'driver') {
            $local = [Net.Sockets.TcpClient]::new('127.0.0.1', $driverPort)
            $owner = Get-NetTCPConnection -State Established -LocalAddress '127.0.0.1' -LocalPort $driverPort `
              -RemoteAddress '127.0.0.1' -RemotePort $local.Client.LocalEndPoint.Port -OwningProcess $driver.Id -ErrorAction SilentlyContinue
            if (-not $owner) { throw 'The local endpoint is not owned by this session worker.' }
            $b = $local.GetStream()
            $up = $a.CopyToAsync($b); $down = $b.CopyToAsync($a)
          } else {
            $peer = Start-PiIdentityPeer (Join-Path $Workspace 'window-identity.ps1')
            $up = [PiIdentityPipe]::CopyAndFlushAsync($a, $peer.StandardInput.BaseStream)
            $down = $peer.StandardOutput.BaseStream.CopyToAsync($a)
          }
          $pairs.Add([pscustomobject]@{ channel = $channel.host; h = $remote; l = $local; peer = $peer; up = $up; down = $down })
        } catch {
          if ($remote) { $remote.Close() }
          if ($local) { $local.Close() }
          if ($peer) { Stop-PiIdentityPeer $peer }
          break
        }
      }
    }
    foreach ($p in @($pairs)) {
      if ($p.up.IsCompleted -or $p.down.IsCompleted) { Close-PiSessionPair $p; [void]$pairs.Remove($p) }
    }
    Start-Sleep -Milliseconds 50
  }
} finally {
  foreach ($p in @($pairs)) { Close-PiSessionPair $p }
}
