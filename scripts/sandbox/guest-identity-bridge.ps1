# A Sandbox identity channel gets its own marker peer only after mutual proof. Closing input removes its markers.
param(
  [int]$Port = 47802,
  [string]$Peer = 'C:\pi\config\window-identity.ps1',
  [string]$Credentials = 'C:\pi\config\identity.json',
  [string]$Address = '0.0.0.0'
)
$ErrorActionPreference = 'Stop'
$auth = Get-Content -Raw -LiteralPath $Credentials | ConvertFrom-Json
if ($auth.session -isnot [string] -or $auth.session -cnotmatch '^[a-zA-Z0-9_-]{1,80}$' -or
    $auth.key -isnot [string] -or $auth.key -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid identity credentials.' }
# Compile the shared pipe helper once before workers enter the same AppDomain.
. (Join-Path $PSScriptRoot 'identity-channel.ps1')
$worker = {
  param($Client, $Auth, $Clock, [string]$Peer, [string]$Helpers)
  $ErrorActionPreference = 'Stop'
  $process = $null
  $up = $null; $down = $null
  $authenticated = $false
  try {
    . (Join-Path $Helpers 'relay-auth.ps1')
    . (Join-Path $Helpers 'identity-auth.ps1')
    . (Join-Path $Helpers 'identity-channel.ps1')
    Accept-PiIdentityClient $Client $Auth $Clock
    $authenticated = $true
    $process = Start-PiIdentityPeer $Peer
    $socket = $Client.GetStream()
    $up = [PiIdentityPipe]::CopyAndFlushAsync($socket, $process.StandardInput.BaseStream)
    $down = $process.StandardOutput.BaseStream.CopyToAsync($socket)
    [void][Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($up, $down))
  } catch {
    # Authentication failures close without service. Do not log the request or credentials.
    if ($authenticated) { [Console]::Error.WriteLine('Window identity channel failed.') }
  } finally {
    # Unblock both network pumps before waiting for the peer's graceful EOF cleanup.
    $Client.Close()
    try { if ($process) { Stop-PiIdentityPeer $process } }
    finally {
      $tasks = @($up, $down) | Where-Object { $null -ne $_ }
      if ($tasks.Count) {
        try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$tasks, 1000) } catch {}
        foreach ($task in $tasks) { if ($task.IsFaulted) { [void]$task.Exception } }
      }
    }
  }
}
$maxClients = 32
$pool = [RunspaceFactory]::CreateRunspacePool(1, $maxClients)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($Address), $Port)
$jobs = [Collections.Generic.List[object]]::new()
try {
  $pool.Open()
  $listener.Start()
  $accept = $listener.AcceptTcpClientAsync()
  while ($true) {
    foreach ($job in @($jobs)) {
      if ($job.result.IsCompleted) {
        try { [void]$job.pipeline.EndInvoke($job.result) }
        catch { [Console]::Error.WriteLine('Window identity worker failed.') }
        finally { $job.pipeline.Dispose(); $job.client.Close(); [void]$jobs.Remove($job) }
      }
    }
    if ($accept.IsCompleted) {
      $client = $accept.GetAwaiter().GetResult()
      $clock = [Diagnostics.Stopwatch]::StartNew()
      $accept = $listener.AcceptTcpClientAsync()
      if ($jobs.Count -ge $maxClients) { $client.Close(); continue }
      $pipeline = [PowerShell]::Create()
      try {
        $pipeline.RunspacePool = $pool
        [void]$pipeline.AddScript($worker.ToString()).AddArgument($client).AddArgument($auth).AddArgument($clock).AddArgument($Peer).AddArgument($PSScriptRoot)
        $result = $pipeline.BeginInvoke()
        $jobs.Add([pscustomobject]@{ client = $client; pipeline = $pipeline; result = $result })
      } catch { $pipeline.Dispose(); $client.Close(); throw }
    }
    Start-Sleep -Milliseconds 20
  }
} finally {
  $listener.Stop()
  if ($client) { $client.Close() }
  if ($accept) {
    # Stop completes a pending accept; an already accepted but undispatched socket is owned here too.
    try { $pending = $accept.GetAwaiter().GetResult(); $pending.Close() } catch {}
  }
  try {
    # Unblock every worker before joining any one of them.
    foreach ($job in @($jobs)) { $job.client.Close() }
    foreach ($job in @($jobs)) {
      try { [void]$job.pipeline.EndInvoke($job.result) }
      catch { [Console]::Error.WriteLine('Window identity worker failed during shutdown.') }
      finally { $job.pipeline.Dispose() }
    }
  } finally {
    try { $pool.Close() } finally { $pool.Dispose() }
  }
}
