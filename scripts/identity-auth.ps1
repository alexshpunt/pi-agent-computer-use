# Server half of the relay proof for a Sandbox identity channel. The shared relay-auth.ps1 is loaded by the caller.
function Accept-PiIdentityClient([Net.Sockets.TcpClient]$Client, $Auth, [Diagnostics.Stopwatch]$Clock) {
  if ($Auth.session -isnot [string] -or $Auth.session -cnotmatch '^[a-zA-Z0-9_-]{1,80}$' -or
      $Auth.key -isnot [string] -or $Auth.key -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid identity credentials.' }
  [void](Get-PiRelayRemaining $Clock)
  $stream = $Client.GetStream()
  $nonceBytes = [byte[]]::new(32)
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($nonceBytes) } finally { $rng.Dispose() }
  $nonce = -join ($nonceBytes | ForEach-Object { $_.ToString('x2') })
  Write-PiRelayFrame $stream $Clock @{ version = 1; nonce = $nonce }
  $request = Read-PiRelayFrame $stream $Clock
  if ($request.version -is [string] -or $request.version -is [bool] -or $request.version -ne 1 -or
      $request.session -isnot [string] -or $request.session -cne $Auth.session -or
      $request.channel -isnot [string] -or $request.channel -cne 'identity' -or
      $request.role -isnot [string] -or $request.role -cne 'client' -or
      $request.nonce -isnot [string] -or $request.nonce -cnotmatch '^[a-f0-9]{64}$' -or
      $request.proof -isnot [string] -or $request.proof -cnotmatch '^[a-f0-9]{64}$') { throw 'Identity authentication failed.' }
  [byte[]]$key = for ($i = 0; $i -lt 64; $i += 2) { [Convert]::ToByte($Auth.key.Substring($i, 2), 16) }
  $expected = Get-PiRelayProof $key 'client' $Auth.session 'identity' $nonce $request.nonce 'client'
  if (-not (Test-PiRelayProof $request.proof $expected)) { throw 'Identity authentication failed.' }
  $proof = Get-PiRelayProof $key 'server' $Auth.session 'identity' $nonce $request.nonce 'client'
  Write-PiRelayFrame $stream $Clock @{ proof = $proof }
  # The deadline belongs to authentication, not the lifetime of a window marker.
  $stream.ReadTimeout = [Threading.Timeout]::Infinite
  $stream.WriteTimeout = [Threading.Timeout]::Infinite
}
