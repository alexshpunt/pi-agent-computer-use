# Runs in an isolated MXC user session. Driver and stream traffic use their owned local endpoints; each authenticated
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
$channels = @(@{ host = $config.hostDriverPort; name = 'driver'; port = $driverPort; owner = $driver.Id; spares = 2 },
  @{ host = $config.hostIdentityPort; name = 'identity'; spares = 2 })
# Window streams for the host's session tiles: cua-spacesd captures windows with PrintWindow and encodes H.264. Its
# token travels in the environment, never on a command line, and only this one child inherits it.
if ($config.stream) {
  $streamPort = Get-FreePort
  $env:CUA_ENV_TOKEN = $config.stream.token
  try {
    $spacesd = Start-Process -PassThru -FilePath (Join-Path $Workspace 'runtime\cua-spacesd.exe') -WindowStyle Hidden `
      -ArgumentList 'serve', '--listen', "127.0.0.1:$streamPort", '--quic-port', '0', '--no-mcp', '--data-dir', (Join-Path $Workspace 'spacesd') `
      -RedirectStandardOutput (Join-Path $out 'spacesd.out') -RedirectStandardError (Join-Path $out 'spacesd.err')
  } finally { Remove-Item Env:CUA_ENV_TOKEN }
  # The hub keeps one gRPC connection and opens one media socket per streamed window, so connections in use have no
  # fixed number: the relay marks each spare it pairs with one byte, and three unmarked spares always wait.
  $channels += @{ host = $config.stream.hostPort; name = 'stream'; port = $streamPort; owner = $spacesd.Id; spares = 3; marked = $true; limit = 48 }
}
$pairs = [Collections.Generic.List[object]]::new()
function Close-PiSessionPair($Pair) {
  $Pair.h.Close()
  if ($Pair.l) { $Pair.l.Close() }
  if ($Pair.peer) { Stop-PiIdentityPeer $Pair.peer }
  # Observe any failed copy tasks after closing their owned streams.
  $null = $Pair.up.Exception; $null = $Pair.down.Exception; $null = $Pair.wait.Exception
}
# A loopback connection to the channel's service, refused unless the session's own service process owns the port.
function Connect-PiOwnedLocal($Channel) {
  $local = [Net.Sockets.TcpClient]::new('127.0.0.1', $Channel.port)
  $owner = Get-NetTCPConnection -State Established -LocalAddress '127.0.0.1' -LocalPort $Channel.port `
    -RemoteAddress '127.0.0.1' -RemotePort $local.Client.LocalEndPoint.Port -OwningProcess $Channel.owner -ErrorAction SilentlyContinue
  if (-not $owner) { $local.Close(); throw 'The local endpoint is not owned by this session worker.' }
  return $local
}
try {
  while ($true) {
    foreach ($channel in $channels) {
      $mine = @($pairs | Where-Object { $_.channel -eq $channel.host })
      # A marked channel offers spares only once its service answers, so no host client waits on a dead one.
      if ($channel.marked -and -not $channel.ready) {
        try { (Connect-PiOwnedLocal $channel).Close(); $channel.ready = $true } catch { continue }
      }
      # Spares per authenticated channel. Identity spares have no markers until the controller sends a request.
      $waiting = if ($channel.marked) { @($mine | Where-Object { $_.wait }).Count } else { $mine.Count }
      $total = $mine.Count
      while ($waiting -lt $channel.spares -and (-not $channel.limit -or $total -lt $channel.limit)) {
        $local = $null; $remote = $null; $peer = $null
        try {
          if ($channel.marked) {
            # The local connection opens when the relay pairs this spare, with its marker byte.
            $remote = Connect-PiRelay $channel.host $config.relay $channel.name
            $marker = [byte[]]::new(1)
            $wait = $remote.GetStream().ReadAsync($marker, 0, 1)
            $pairs.Add([pscustomobject]@{ channel = $channel.host; h = $remote; l = $null; peer = $null; up = $null; down = $null; wait = $wait; marker = $marker; service = $channel })
          } elseif ($channel.port) {
            # The local end first: a host spare must never wait in the relay for a service that is not up yet.
            $local = Connect-PiOwnedLocal $channel
            $remote = Connect-PiRelay $channel.host $config.relay $channel.name
            $a = $remote.GetStream(); $b = $local.GetStream()
            $up = $a.CopyToAsync($b); $down = $b.CopyToAsync($a)
            $pairs.Add([pscustomobject]@{ channel = $channel.host; h = $remote; l = $local; peer = $null; up = $up; down = $down })
          } else {
            $remote = Connect-PiRelay $channel.host $config.relay $channel.name
            $a = $remote.GetStream()
            $peer = Start-PiIdentityPeer (Join-Path $Workspace 'window-identity.ps1')
            $up = [PiIdentityPipe]::CopyAndFlushAsync($a, $peer.StandardInput.BaseStream)
            $down = $peer.StandardOutput.BaseStream.CopyToAsync($a)
            $pairs.Add([pscustomobject]@{ channel = $channel.host; h = $remote; l = $null; peer = $peer; up = $up; down = $down })
          }
          $waiting++; $total++
        } catch {
          if ($remote) { $remote.Close() }
          if ($local) { $local.Close() }
          if ($peer) { Stop-PiIdentityPeer $peer }
          break
        }
      }
    }
    foreach ($p in @($pairs)) {
      if ($p.wait) {
        if (-not $p.wait.IsCompleted) { continue }
        $paired = $p.wait.Status -eq 'RanToCompletion' -and $p.wait.Result -eq 1 -and $p.marker[0] -eq 1
        $p.wait = $null
        if ($paired) {
          try {
            $p.l = Connect-PiOwnedLocal $p.service
            $a = $p.h.GetStream(); $b = $p.l.GetStream()
            $p.up = $a.CopyToAsync($b); $p.down = $b.CopyToAsync($a)
          } catch { $paired = $false }
        }
        if (-not $paired) { Close-PiSessionPair $p; [void]$pairs.Remove($p) }
        continue
      }
      if ($p.up.IsCompleted -or $p.down.IsCompleted) { Close-PiSessionPair $p; [void]$pairs.Remove($p) }
    }
    Start-Sleep -Milliseconds 50
  }
} finally {
  foreach ($p in @($pairs)) { Close-PiSessionPair $p }
}
