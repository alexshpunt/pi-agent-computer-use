import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SandboxHost } from "./sandbox.ts";

/**
 * The session tile host (native/tile-host): a small WinForms + WebView2 program that shows every isolated session's
 * windows as live tiles on the human's desktop layer. It is compiled on the machine that shows the tiles, with the
 * .NET Framework 4.8 compiler every Windows 11 has, against the WebView2 SDK downloaded from NuGet and checked against
 * its pinned hash. A build is kept per source version under %LOCALAPPDATA%\PiComputerUse\tile-host\<version>\.
 */
const SOURCE = new URL("../native/tile-host/", import.meta.url);
export const TILE_HOST_FILES = ["TileHost.cs", "page/index.html", "page/tiles.css", "page/tiles.js", "page/layout.js", "page/stream.js"] as const;
export const TILE_HOST_EXE = "pi-tile-host.exe";
/** The mutex the running host owns in its desktop session (Instance.Name in TileHost.cs). */
export const TILE_HOST_INSTANCE = "Local\\PiComputerUse.TileHost";
/** The WebView2 SDK the host compiles against. Its license (BSD-3-Clause) is copied next to the build. */
export const WEBVIEW2_SDK = {
  version: "1.0.4370.26",
  url: "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4370.26/microsoft.web.webview2.1.0.4370.26.nupkg",
  sha256: "1c0dacac84b70109b3fd42f90c53a0ba942abc3a87590d7a4e0ccd86e4a06cf4",
  files: ["lib/net462/Microsoft.Web.WebView2.Core.dll", "lib/net462/Microsoft.Web.WebView2.WinForms.dll", "runtimes/win-x64/native/WebView2Loader.dll", "LICENSE.txt"],
} as const;

/** Starts the tile host on a session's machine; resolves to "started" or "running". */
export type TileHostStarter = (host: SandboxHost, localAppData: string) => Promise<"started" | "running">;

const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The host's sources and the version that names their build. */
export async function tileHostSources(): Promise<{ version: string; files: { name: string; content: string }[] }> {
  const files = await Promise.all(TILE_HOST_FILES.map(async name => ({ name, content: await readFile(new URL(name, SOURCE), "utf8") })));
  return { version: tileHostVersion(files), files };
}

/** A hash of everything a build depends on: the sources, the SDK pin and the build recipe (compiler flags, references). */
export function tileHostVersion(files: readonly { name: string; content: string }[], recipe = buildScript("", "", "")): string {
  const hash = createHash("sha256").update(WEBVIEW2_SDK.sha256).update(`\0${recipe}`);
  for (const file of files) hash.update(`\0${file.name}\0${file.content}`);
  return hash.digest("hex").slice(0, 16);
}

/** PowerShell that builds the staged sources into the version folder, unless another start already did. */
export function buildScript(root: string, version: string, staging: string): string {
  const sdk = `${root}\\webview2-sdk-${WEBVIEW2_SDK.version}`;
  const entries = WEBVIEW2_SDK.files.map(psString).join(", ");
  return `$ErrorActionPreference = 'Stop'
$root = ${psString(root)}; $dir = Join-Path $root ${psString(version)}; $staging = ${psString(staging)}; $sdk = ${psString(sdk)}
if (Test-Path -LiteralPath (Join-Path $dir '${TILE_HOST_EXE}')) { Remove-Item -Recurse -Force -LiteralPath $staging; return 'built' }
if (-not (Test-Path -LiteralPath (Join-Path $sdk 'Microsoft.Web.WebView2.Core.dll'))) {
  $suffix = [Guid]::NewGuid().ToString('n'); $package = "$sdk.$suffix.nupkg"; $unpacked = "$sdk.$suffix"
  Invoke-WebRequest -UseBasicParsing -Uri ${psString(WEBVIEW2_SDK.url)} -OutFile $package
  try {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash -ne ${psString(WEBVIEW2_SDK.sha256.toUpperCase())}) { throw 'The WebView2 SDK download does not match its pinned SHA-256.' }
    New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($package)
    try { foreach ($entry in $zip.Entries) { if (@(${entries}) -contains $entry.FullName) { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $unpacked $entry.Name), $true) } } }
    finally { $zip.Dispose() }
  } finally { Remove-Item -Force -LiteralPath $package -ErrorAction SilentlyContinue }
  # Another start may have unpacked the same SDK meanwhile; either copy is the pinned one.
  try { Rename-Item -LiteralPath $unpacked -NewName (Split-Path $sdk -Leaf) } catch { if (-not (Test-Path -LiteralPath $sdk)) { throw }; Remove-Item -Recurse -Force -LiteralPath $unpacked }
}
Copy-Item -Path (Join-Path $sdk '*') -Destination $staging
$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
# The compiler's own output is the error report; under Stop its stderr would end the script before it is read.
$ErrorActionPreference = 'Continue'
$out = & $csc /nologo /target:winexe /platform:x64 /optimize+ /out:"$staging\\${TILE_HOST_EXE}" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll /r:"$staging\\Microsoft.Web.WebView2.Core.dll" /r:"$staging\\Microsoft.Web.WebView2.WinForms.dll" "$staging\\TileHost.cs" 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "The tile host did not compile: $out" }
$ErrorActionPreference = 'Stop'
Remove-Item -Force -LiteralPath "$staging\\TileHost.cs"
try { Rename-Item -LiteralPath $staging -NewName ${psString(version)} } catch { if (-not (Test-Path -LiteralPath (Join-Path $dir '${TILE_HOST_EXE}'))) { throw }; Remove-Item -Recurse -Force -LiteralPath $staging }
'built'`;
}

/**
 * PowerShell that starts the host in this desktop session unless one runs there. The running host owns the instance
 * mutex and a leaving one releases it before its last look for sessions, so a host found owning it will see this
 * session's stream.json. The host takes the mutex itself, so two Pi processes starting it at once still get one.
 */
export function startScript(root: string, version: string): string {
  return `$exe = Join-Path ${psString(`${root}\\${version}`)} '${TILE_HOST_EXE}'
$mutex = $null
if ([Threading.Mutex]::TryOpenExisting(${psString(TILE_HOST_INSTANCE)}, [ref]$mutex)) {
  try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { $mutex.Dispose(); return 'running' }
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
Start-Process -FilePath $exe -WindowStyle Hidden | Out-Null
'started'`;
}

/**
 * Build the tile host on the session's machine once per version and start it in the human's desktop session.
 * Started through the machine's Windows PowerShell, it runs in the signed-in user's session, also over SSH into WSL.
 */
export const startTileHost: TileHostStarter = async (host, localAppData) => {
  const root = `${localAppData}\\PiComputerUse\\tile-host`;
  const { version, files } = await tileHostSources();
  const built = (await host.powershell(`Test-Path -LiteralPath ${psString(`${root}\\${version}\\${TILE_HOST_EXE}`)}`)).trim() === "True";
  if (!built) {
    const staging = `${root}\\${version}.staging-${randomUUID().slice(0, 8)}`;
    const unix = await host.path(staging, "unix");
    await host.mkdir(`${unix}/page`);
    for (const file of files) await host.writeFile(`${unix}/${file.name}`, file.content);
    const result = (await host.powershell(buildScript(root, version, staging), undefined, 300_000)).trim();
    if (!result.endsWith("built")) throw new Error(`The tile host build reported: ${result.slice(0, 300) || "nothing"}`);
  }
  const state = (await host.powershell(startScript(root, version), undefined, 30_000)).trim();
  if (state !== "started" && state !== "running") throw new Error(`The tile host start reported: ${state.slice(0, 300) || "nothing"}`);
  return state;
};
