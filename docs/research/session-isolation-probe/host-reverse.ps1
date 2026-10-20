# Host side: pair each client connection on $ClientPort with the next connection the session dials to $SessionPort.
$clients = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $clients.Start()
$sessions = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0); $sessions.Start()
Set-Content C:\Users\Public\pi-mxc\port.txt $sessions.LocalEndpoint.Port
"ports " + $clients.LocalEndpoint.Port + " " + $sessions.LocalEndpoint.Port
$pairs = [Collections.Generic.List[object]]::new()
$accept = $clients.AcceptTcpClientAsync()
while ($true) {
  if ($accept.Wait(200)) {
    $client = $accept.Result; $accept = $clients.AcceptTcpClientAsync()
    $session = $sessions.AcceptTcpClient()
    $a = $client.GetStream(); $b = $session.GetStream()
    $pairs.Add([pscustomobject]@{ c = $client; s = $session; up = $a.CopyToAsync($b); down = $b.CopyToAsync($a) })
  }
  foreach ($p in @($pairs)) { if ($p.up.IsCompleted -or $p.down.IsCompleted) { $p.c.Close(); $p.s.Close(); [void]$pairs.Remove($p) } }
}
