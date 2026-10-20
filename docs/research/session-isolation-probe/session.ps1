$env:CUA_DRIVER_RS_MCP_HTTP_PORT = '52401'
$env:CUA_DRIVER_RS_MCP_HTTP_TOKEN = 'pi-mxc-probe-token-0123456789abcdef0123456789'
$env:CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false'; $env:CUA_DRIVER_RS_UPDATE_CHECK = 'false'; $env:DO_NOT_TRACK = '1'
Start-Process notepad.exe
$d = Start-Process -FilePath 'C:\Users\Public\pi-mxc\runtime\cua-driver.exe' -ArgumentList 'serve' -PassThru -WindowStyle Hidden
"driver pid " + $d.Id + " session " + $d.SessionId
Start-Sleep 4
$hostPort = [int](Get-Content C:\Users\Public\pi-mxc\port.txt).Trim()
"host port " + $hostPort
# Session side: keep 8 outbound connections to the host relay, each piped to the local driver; replace closed ones.
$pairs = [Collections.Generic.List[object]]::new(); $deadline = (Get-Date).AddSeconds(170)
while ((Get-Date) -lt $deadline) {
  while ($pairs.Count -lt 8) {
    try {
      $h = [Net.Sockets.TcpClient]::new('127.0.0.1', $hostPort); $l = [Net.Sockets.TcpClient]::new('127.0.0.1', 52401)
      $a = $h.GetStream(); $b = $l.GetStream()
      $pairs.Add([pscustomobject]@{ h = $h; l = $l; up = $a.CopyToAsync($b); down = $b.CopyToAsync($a) })
    } catch { Start-Sleep -Milliseconds 300; break }
  }
  foreach ($p in @($pairs)) { if ($p.up.IsCompleted -or $p.down.IsCompleted) { $p.h.Close(); $p.l.Close(); [void]$pairs.Remove($p) } }
  Start-Sleep -Milliseconds 100
}
Stop-Process -Id $d.Id -Force -ErrorAction SilentlyContinue
