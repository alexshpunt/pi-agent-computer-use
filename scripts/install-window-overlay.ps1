param([Parameter(Mandatory=$true)][string]$Release, [switch]$Update)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$destination = "$env:LOCALAPPDATA\Programs\PiComputerUsePoC\window-overlay-0.1.0"
if ((Test-Path $destination) -and !$Update) { throw 'A helper already exists here. Close it and use explicit -Update after reviewing the new release.' }
if ($Update -and !(Test-Path (Join-Path $destination 'pi-window-overlay.exe'))) { throw 'Update requires the existing user-local helper.' }
if (Get-Process pi-window-overlay -ErrorAction SilentlyContinue) { throw 'Close the rendering helper before installing or updating it.' }
$manifest = Get-Content (Join-Path $Release 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.qt -ne '6.11.3' -or !$manifest.source_supplied) { throw 'Use the qualified release with corresponding Qt source.' }
foreach ($file in $manifest.files) {
    if ($file.path -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$))') { throw 'Unsafe artifact path.' }
    $source = Join-Path $Release $file.path
    if ((Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Artifact hash mismatch: $($file.path)" }
}
if (!(Test-Path $destination)) { New-Item -ItemType Directory $destination | Out-Null }
# Explicit user-local deployment only; no PATH, service, registry or administrator changes.
Copy-Item (Join-Path $Release 'runtime\*') $destination -Recurse -Force
Copy-Item (Join-Path $Release 'qtbase-source.tar.gz'),(Join-Path $Release 'qt-kit-qconfig.pri'),(Join-Path $Release 'manifest.json') $destination -Force
Copy-Item (Join-Path $Release 'helper-source') $destination -Recurse -Force
@{installed=$destination; source_supplied=$true; bytes=(Get-ChildItem $destination -File -Recurse | Measure-Object -Property Length -Sum).Sum} | ConvertTo-Json -Compress
