param([Parameter(Mandatory=$true)][string]$Artifact)
$ErrorActionPreference = 'Stop'
# Hash a file with the built-in .NET runtime; no PowerShell module install.
function Get-ArtifactHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
$source = 'bba07a9c8ccba117c1057a3a0003e95d3693b2b3'
$destination = Join-Path $env:LOCALAPPDATA 'Programs\PiComputerUsePoC\cua-driver-0.34.0-held-bba07a9'
$hashes = @{
    'cua-driver.exe' = '1ff0625b34fdb2116ebf253455e7eea2b9221fc81450f180ec4dc0ddc26d7224'
    'cua-driver-uia.exe' = '878a591f541492c8f00689ba57b952a17e0c577c8910edc7ba4648c259a1a665'
    'cua-cursor-theme.exe' = 'c2f49b6081be05ae44daa4dd135ac12d0112152f35ae8cbb35e92ddb96d170c4'
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
# Explicit user-local deployment only. Keep 0.33.2; do not change PATH,
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
    ci = 'https://github.com/alexshpunt/cua/actions/runs/37424342851'
    unsigned = $true
    transport = 'upstream_mcp_envelopes'
    files = $hashes
} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $destination 'qualification.json') -Encoding UTF8
foreach ($name in $hashes.Keys) {
    if ((Get-ArtifactHash (Join-Path $destination $name)) -ne $hashes[$name]) { throw "Installed hash mismatch: $name" }
}
@{installed = $destination; source = $source; driver_sha256 = $hashes['cua-driver.exe']; unsigned = $true} | ConvertTo-Json -Compress
