param([Parameter(Mandatory=$true)][string]$Artifact)
$ErrorActionPreference = 'Stop'
# Hash a file with the built-in .NET runtime; no PowerShell module install.
function Get-ArtifactHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
$source = '3b3305044b7b327310615aa99d3307948a63061c'
$destination = Join-Path $env:LOCALAPPDATA 'Programs\PiComputerUsePoC\cua-driver-0.34.0-keys-3b330504'
$hashes = @{
    'cua-driver.exe' = '9786ace009b81fb2555f14f64b605ab20c3bfc309493398424be1183532df749'
    'cua-driver-uia.exe' = '2275bc7e35ce91086999af53429c8df3049eab440e48fa58a1a195214151334d'
    'cua-cursor-theme.exe' = '68cb5e94a4378f7378dd765beaddec41e0557a866603c7ae337f07d2de0344c1'
}
if (Test-Path $destination) { throw 'Destination already exists. Inspect it; this installer never overwrites a runtime.' }
if ((Get-Content (Join-Path $Artifact 'source-sha.txt') -Raw).Trim() -ne $source) { throw 'Wrong source revision.' }
if ((Get-Content (Join-Path $Artifact 'version.txt') -Raw).Trim() -ne 'cua-driver 0.34.0') { throw 'Wrong driver version.' }
foreach ($name in $hashes.Keys) {
    $file = Join-Path $Artifact "runtime\$name"
    if ((Get-ArtifactHash $file) -ne $hashes[$name]) { throw "Wrong artifact bytes: $name" }
}
$notices = @('LICENSE.md', 'THIRD_PARTY_NOTICES.md', 'BUILD-NOTICE.txt')
foreach ($name in $notices) {
    if (!(Test-Path (Join-Path $Artifact "runtime\$name") -PathType Leaf)) { throw "Missing notice: $name" }
}
# Explicit user-local deployment only. Keep 0.33.2 and the mouse-path fork; do not change PATH,
# services, registry, signing trust, autostart or administrator permissions.
New-Item -ItemType Directory -Path $destination | Out-Null
foreach ($name in @($hashes.Keys) + $notices) {
    Copy-Item (Join-Path $Artifact "runtime\$name") $destination
}
foreach ($name in @('source-sha.txt', 'version.txt', 'hashes.json', 'signatures.json', 'rustc.txt', 'cargo.txt', 'toolchain.txt')) {
    Copy-Item (Join-Path $Artifact $name) $destination
}
@{
    source = $source
    source_url = "https://github.com/alexshpunt/cua/tree/$source"
    ci = 'https://github.com/alexshpunt/cua/actions/runs/37449622352'
    unsigned = $true
    transport = 'upstream_mcp_envelopes'
    files = $hashes
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $destination 'qualification.json') -Encoding UTF8
foreach ($name in $hashes.Keys) {
    if ((Get-ArtifactHash (Join-Path $destination $name)) -ne $hashes[$name]) { throw "Installed hash mismatch: $name" }
}
@{installed = $destination; source = $source; driver_sha256 = $hashes['cua-driver.exe']; unsigned = $true} | ConvertTo-Json -Compress
