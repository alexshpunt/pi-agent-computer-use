# Runs on the Windows host without elevation. Relays an OS-chosen 127.0.0.1 port to one sandbox guest port,
# because WSL with mirrored networking cannot route to the sandbox NAT subnet. Writes "<port> <pid>" to $PortFile.
param([Parameter(Mandatory)][string]$GuestIp, [Parameter(Mandatory)][int]$GuestPort, [Parameter(Mandatory)][string]$PortFile)
$ErrorActionPreference = 'Stop'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
Set-Content -Path $PortFile -Value ("{0} {1}" -f $listener.LocalEndpoint.Port, $PID)
# Connections are pumped asynchronously, so a long-lived identity connection never blocks driver calls.
$pairs = [Collections.Generic.List[object]]::new()
$accept = $listener.AcceptTcpClientAsync()
while ($true) {
  if ($accept.Wait(200)) {
    $client = $accept.Result
    $accept = $listener.AcceptTcpClientAsync()
    try {
      $guest = [Net.Sockets.TcpClient]::new($GuestIp, $GuestPort)
      $a = $client.GetStream(); $b = $guest.GetStream()
      $pairs.Add([pscustomobject]@{ client = $client; guest = $guest; up = $a.CopyToAsync($b); down = $b.CopyToAsync($a) })
    } catch { $client.Close() }
  }
  foreach ($pair in @($pairs)) {
    if ($pair.up.IsCompleted -or $pair.down.IsCompleted) {
      $pair.client.Close(); $pair.guest.Close(); [void]$pairs.Remove($pair)
    }
  }
}
