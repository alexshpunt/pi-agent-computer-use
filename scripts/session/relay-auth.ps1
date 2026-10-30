# Windows PowerShell 5.1 peer for src/relay-auth.ts. No StreamReader: read-ahead would lose application bytes.
function Get-PiRelayRemaining($Clock) {
  $remaining = 3000 - [int]$Clock.ElapsedMilliseconds
  if ($remaining -le 0) { throw 'Relay authentication timed out.' }
  return $remaining
}
function Read-PiRelayFrame($Stream, $Clock) {
  $bytes = [Collections.Generic.List[byte]]::new()
  while ($true) {
    $Stream.ReadTimeout = Get-PiRelayRemaining $Clock
    $b = $Stream.ReadByte()
    if ($b -lt 0) { throw 'Relay closed during authentication.' }
    if ($b -eq 10) { break }
    $bytes.Add([byte]$b)
    if ($bytes.Count -gt 512) { throw 'Relay authentication frame is too large.' }
  }
  return ([Text.Encoding]::UTF8.GetString($bytes.ToArray()) | ConvertFrom-Json)
}
function Write-PiRelayFrame($Stream, $Clock, $Frame) {
  $Stream.WriteTimeout = Get-PiRelayRemaining $Clock
  $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Frame -Compress) + "`n")
  $Stream.Write($bytes, 0, $bytes.Length)
}
function Get-PiRelayProof([byte[]]$Key, [string]$Side, [string]$Session, [string]$Channel, [string]$ServerNonce, [string]$ClientNonce, [string]$Role = 'session') {
  $mac = [Security.Cryptography.HMACSHA256]::new($Key)
  try {
    $transcript = ConvertTo-Json -InputObject @('pi-relay', 1, $Side, $Session, $Channel, $Role, $ServerNonce, $ClientNonce) -Compress
    return (-join ($mac.ComputeHash([Text.Encoding]::UTF8.GetBytes($transcript)) | ForEach-Object { $_.ToString('x2') }))
  } finally { $mac.Dispose() }
}
function Test-PiRelayProof([string]$Actual, [string]$Expected) {
  if ($Actual -cnotmatch '^[a-f0-9]{64}$') { return $false }
  $difference = 0
  for ($i = 0; $i -lt 64; $i++) { $difference = $difference -bor ([int]$Actual[$i] -bxor [int]$Expected[$i]) }
  return $difference -eq 0
}
function Connect-PiRelay([int]$Port, $Auth, [string]$Channel) {
  if ($Auth.session -cnotmatch '^[a-zA-Z0-9_-]{1,80}$' -or $Auth.key -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid relay credentials.' }
  $tcp = [Net.Sockets.TcpClient]::new()
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    $connecting = $tcp.ConnectAsync('127.0.0.1', $Port)
    if (-not $connecting.Wait((Get-PiRelayRemaining $clock))) { throw 'Relay connection timed out.' }
    $stream = $tcp.GetStream()
    $challenge = Read-PiRelayFrame $stream $clock
    if ($challenge.version -ne 1 -or $challenge.nonce -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid relay challenge.' }
    [byte[]]$key = for ($i = 0; $i -lt 64; $i += 2) { [Convert]::ToByte($Auth.key.Substring($i, 2), 16) }
    $nonceBytes = [byte[]]::new(32)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($nonceBytes) } finally { $rng.Dispose() }
    $nonce = -join ($nonceBytes | ForEach-Object { $_.ToString('x2') })
    $clientProof = Get-PiRelayProof $key 'client' $Auth.session $Channel $challenge.nonce $nonce
    Write-PiRelayFrame $stream $clock @{ version = 1; session = $Auth.session; channel = $Channel; role = 'session'; nonce = $nonce; proof = $clientProof }
    $reply = Read-PiRelayFrame $stream $clock
    $expected = Get-PiRelayProof $key 'server' $Auth.session $Channel $challenge.nonce $nonce
    if (-not (Test-PiRelayProof $reply.proof $expected)) { throw 'Relay server authentication failed.' }
    $stream.ReadTimeout = [Threading.Timeout]::Infinite
    $stream.WriteTimeout = [Threading.Timeout]::Infinite
    return $tcp
  } catch { $tcp.Close(); throw }
}
