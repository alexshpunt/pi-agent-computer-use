# Runs on the Windows host without elevation, for an isolated agent session (MXC isolation_session). The session
# has its own loopback: it can dial the host's loopback but the host cannot dial in. For each channel this opens a
# client port and a session port on OS-chosen loopback ports, and pairs every client connection with the next
# connection the session dials in. Writes "<client> <session>" per channel and then this PID to $PortFile.
param([Parameter(Mandatory)][int]$Channels, [Parameter(Mandatory)][string]$PortFile)
$ErrorActionPreference = 'Stop'
$listeners = foreach ($i in 1..$Channels) {
  $client = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $client.Start()
  $session = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $session.Start()
  [pscustomobject]@{ client = $client; session = $session; accept = $client.AcceptTcpClientAsync() }
}
$ports = ($listeners | ForEach-Object { "{0} {1}" -f $_.client.LocalEndpoint.Port, $_.session.LocalEndpoint.Port }) -join ' '
Set-Content -Path $PortFile -Value "$ports $PID"
$pairs = [Collections.Generic.List[object]]::new()
while ($true) {
  foreach ($l in $listeners) {
    if ($l.accept.IsCompleted) {
      $client = $l.accept.Result; $l.accept = $l.client.AcceptTcpClientAsync()
      # The session keeps spare connections dialled in, so this returns at once while the session is up.
      $session = $l.session.AcceptTcpClient()
      $a = $client.GetStream(); $b = $session.GetStream()
      $pairs.Add([pscustomobject]@{ c = $client; s = $session; up = $a.CopyToAsync($b); down = $b.CopyToAsync($a) })
    }
  }
  foreach ($p in @($pairs)) { if ($p.up.IsCompleted -or $p.down.IsCompleted) { $p.c.Close(); $p.s.Close(); [void]$pairs.Remove($p) } }
  Start-Sleep -Milliseconds 20
}
