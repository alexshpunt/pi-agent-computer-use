# Owned marker peers use only stdio; no local TCP endpoint is exposed.
if (-not ('PiIdentityPipe' -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot 'identity-channel.cs')
}
function Start-PiIdentityPeer([string]$Peer) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes((Get-Content -Raw -LiteralPath $Peer)))
  $info = [Diagnostics.ProcessStartInfo]::new('powershell.exe', "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded")
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.CreateNoWindow = $true
  return [Diagnostics.Process]::Start($info)
}
function Stop-PiIdentityPeer($Process) {
  if (-not $Process) { return }
  try {
    if (-not $Process.HasExited) {
      try { $Process.StandardInput.Close() } catch [IO.IOException] { }
      if (-not $Process.WaitForExit(5000)) {
        $Process.Kill()
        if (-not $Process.WaitForExit(2000)) { throw 'Identity peer shutdown is unconfirmed.' }
      }
    }
  } finally { $Process.Dispose() }
}
