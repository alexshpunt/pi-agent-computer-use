param(
    [Parameter(Mandatory=$true)][string]$QtPrefix,
    [string]$BuildRoot = "$env:LOCALAPPDATA\Programs\PiComputerUsePoC\.tmp\window-overlay-build"
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Build on a Windows-local path: MSBuild's case folding is unsafe on a case-sensitive WSL source share.
$source = Join-Path $BuildRoot 'source'
$build = Join-Path $BuildRoot 'build'
$bundle = Join-Path $BuildRoot 'bundle'
$vs = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
$cmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (!(Test-Path $cmake) -or !(Test-Path "$QtPrefix\bin\windeployqt.exe")) { throw 'Existing MSVC Build Tools and the qualified Qt Widgets kit are required.' }
New-Item -ItemType Directory -Force $source,$build,$bundle | Out-Null
Copy-Item "$PSScriptRoot\..\native\window-overlay\*" $source -Force
& $cmake -S $source -B $build -G 'Visual Studio 17 2022' -A x64 "-DCMAKE_PREFIX_PATH=$QtPrefix"
if ($LASTEXITCODE -ne 0) { throw 'CMake configure failed.' }
& $cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw 'Native helper build failed.' }
Copy-Item "$build\Release\pi-window-overlay.exe" $bundle -Force
& "$QtPrefix\bin\windeployqt.exe" --release --no-patchqt --no-translations --no-quick-import --no-compiler-runtime --no-opengl-sw --no-system-d3d-compiler --skip-plugin-types generic,tls,networkinformation,imageformats,styles --qtpaths "$QtPrefix\bin\qtpaths.exe" --dir $bundle "$bundle\pi-window-overlay.exe"
if ($LASTEXITCODE -ne 0) { throw 'Qt deployment failed.' }
Copy-Item "$source\qt.conf" $bundle -Force
$files = @(Get-ChildItem $bundle -File -Recurse | ForEach-Object {
    @{path=$_.FullName.Substring($bundle.Length+1); bytes=$_.Length; sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$files | ConvertTo-Json -Depth 4 | Set-Content "$BuildRoot\bundle-manifest.json" -Encoding UTF8
$toolset = Get-ChildItem "$vs\VC\Tools\MSVC" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$dumpbin = Join-Path $toolset.FullName 'bin\Hostx64\x64\dumpbin.exe'
Get-ChildItem $bundle -Recurse -File | Where-Object { $_.Extension -in '.dll','.exe' } | ForEach-Object {
    $_.FullName
    & $dumpbin /dependents $_.FullName
    if ($LASTEXITCODE -ne 0) { throw 'DLL dependency inspection failed.' }
} | Set-Content "$BuildRoot\imports.txt" -Encoding UTF8
@{bundle=$bundle; bytes=($files | ForEach-Object { $_.bytes } | Measure-Object -Sum).Sum; files=$files.Count; qt=(& "$QtPrefix\bin\qtpaths.exe" --query QT_VERSION)} | ConvertTo-Json -Compress
