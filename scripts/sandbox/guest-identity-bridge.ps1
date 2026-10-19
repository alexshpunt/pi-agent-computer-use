# Runs in a Windows Sandbox guest session. For each host connection, start the window identity peer
# (window-identity.ps1) and pump bytes between the socket and its stdio. Closing the connection ends the
# peer's input, so it removes its window markers and exits.
param([int]$Port = 47802, [string]$Peer = 'C:\pi\config\window-identity.ps1')
$ErrorActionPreference = 'Stop'
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes((Get-Content -Raw $Peer)))
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $Port)
$listener.Start()
while ($true) {
  $client = $listener.AcceptTcpClient()
  $process = $null
  try {
    $info = [Diagnostics.ProcessStartInfo]::new('powershell.exe', "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded")
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($info)
    $socket = $client.GetStream()
    $down = $process.StandardOutput.BaseStream.CopyToAsync($socket)
    # The peer's stdin is a buffered stream: flush every chunk so each request line reaches it at once.
    $input = $process.StandardInput.BaseStream
    $buffer = [byte[]]::new(4096)
    while (($read = $socket.Read($buffer, 0, $buffer.Length)) -gt 0) { $input.Write($buffer, 0, $read); $input.Flush() }
    $process.StandardInput.Close()
    [void]$process.WaitForExit(10000)
    [void]$down.Wait(5000)
  } catch { } finally {
    if ($process -and -not $process.HasExited) { $process.Kill() }
    $client.Close()
  }
}
