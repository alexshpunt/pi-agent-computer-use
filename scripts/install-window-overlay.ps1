param([Parameter(Mandatory=$true)][string]$Release)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$destination = "$env:LOCALAPPDATA\Programs\PiComputerUsePoC\window-overlay-0.1.0"
if (Test-Path $destination) { throw 'A helper already exists here. Close it and review the existing install before replacing anything.' }
$manifest = Get-Content (Join-Path $Release 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.qt -ne '6.11.3' -or !$manifest.source_supplied) { throw 'Use the qualified release with corresponding Qt source.' }
foreach ($file in $manifest.files) {
    if ($file.path -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$))') { throw 'Unsafe artifact path.' }
    $source = Join-Path $Release $file.path
    if ((Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Artifact hash mismatch: $($file.path)" }
}
New-Item -ItemType Directory $destination | Out-Null
# Explicit user-local deployment only; no PATH, service, registry or administrator changes.
Copy-Item (Join-Path $Release 'runtime\*') $destination -Recurse
Copy-Item (Join-Path $Release 'qtbase-source.tar.gz'),(Join-Path $Release 'qt-kit-qconfig.pri'),(Join-Path $Release 'manifest.json') $destination
Copy-Item (Join-Path $Release 'helper-source') $destination -Recurse
@{installed=$destination; source_supplied=$true; bytes=(Get-ChildItem $destination -File -Recurse | Measure-Object -Property Length -Sum).Sum} | ConvertTo-Json -Compress
