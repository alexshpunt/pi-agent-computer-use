import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WINDOWS_POWERSHELL, runPowerShell, type CommandRunner } from "./runner.ts";
import { RemotePreparationUncertain } from "./remote-provision-error.ts";
import { WINDOWS_NODE } from "./setup-pins.ts";

/** Install tsx with Windows npm so its esbuild executable matches the Windows worker, even when Pi runs in WSL. */
export async function prepareWindowsTsx(runner: CommandRunner, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const [manifest, lock] = await Promise.all([
    readFile(new URL("./browser-loader/package.json", import.meta.url)),
    readFile(new URL("./browser-loader/package-lock.json", import.meta.url)),
  ]);
  signal?.throwIfAborted();
  const cacheKey = createHash("sha256").update(manifest).update(lock).digest("hex");
  const script = `
$root = Join-Path $env:LOCALAPPDATA 'PiComputerUse\\browser-loader'
$dir = Join-Path $root '${cacheKey}'
$loader = Join-Path $dir 'node_modules\\tsx\\dist\\loader.mjs'
$binary = Join-Path $dir 'node_modules\\@esbuild\\win32-x64\\esbuild.exe'
if (!(Test-Path -LiteralPath $dir)) {
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (!$npm) {
    $portable = Join-Path $env:LOCALAPPDATA 'Programs\\PiComputerUse\\node-${WINDOWS_NODE.version}-win-x64\\npm.cmd'
    if (Test-Path -LiteralPath $portable -PathType Leaf) { $npm = $portable }
  }
  if (!$npm) {
    # The automatic browser setup may have installed only node.exe. Use the same pinned Node ZIP as /computer-setup
    # when npm is absent; npm.cmd and its own node.exe remain together in a private cache.
    $nodeRoot = Join-Path $env:LOCALAPPDATA 'PiComputerUse\\browser-node-full'
    $nodeDir = Join-Path $nodeRoot '${WINDOWS_NODE.sha256}'
    $npm = Join-Path $nodeDir 'npm.cmd'
    if (!(Test-Path -LiteralPath $nodeDir)) {
      New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
      $nodeStage = Join-Path $nodeRoot ('.staging-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $nodeStage | Out-Null
      try {
        $zip = Join-Path $nodeStage 'node.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        (New-Object Net.WebClient).DownloadFile('${WINDOWS_NODE.url}', $zip)
        $stream = [IO.File]::OpenRead($zip)
        try { $hash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Dispose() }
        if ($hash -ne '${WINDOWS_NODE.sha256}') { throw 'The Windows Node download failed integrity verification.' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, (Join-Path $nodeStage 'unpacked'))
        $unpacked = Join-Path $nodeStage 'unpacked\\node-${WINDOWS_NODE.version}-win-x64'
        try { [IO.Directory]::Move($unpacked, $nodeDir) } catch { if (!(Test-Path -LiteralPath $nodeDir)) { throw } }
      } finally { if (Test-Path -LiteralPath $nodeStage) { Remove-Item -LiteralPath $nodeStage -Recurse -Force } }
    }
    if (((Get-Item -Force -LiteralPath $nodeDir).Attributes -band [IO.FileAttributes]::ReparsePoint) -or !(Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'The Windows npm cache is incomplete.' }
  }
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $stage = Join-Path $root ('.staging-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    [IO.File]::WriteAllBytes((Join-Path $stage 'package.json'), [Convert]::FromBase64String('${manifest.toString("base64")}'))
    [IO.File]::WriteAllBytes((Join-Path $stage 'package-lock.json'), [Convert]::FromBase64String('${lock.toString("base64")}'))
    & $npm ci --prefix $stage --ignore-scripts --no-audit --no-fund | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the Windows TypeScript loader.' }
    try { [IO.Directory]::Move($stage, $dir) } catch { if (!(Test-Path -LiteralPath $dir)) { throw } }
  } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force } }
}
if (((Get-Item -Force -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) -or !(Test-Path -LiteralPath $loader -PathType Leaf) -or !(Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'The Windows TypeScript loader cache is incomplete.' }
([Uri]$loader).AbsoluteUri`;
  try {
    const url = await runPowerShell(runner, WINDOWS_POWERSHELL, script, { timeoutMs: 600_000, scriptOnStdin: true });
    if (!url.startsWith("file:///")) throw new Error("The Windows loader path is invalid.");
    signal?.throwIfAborted();
    return url;
  } catch (error) {
    throw new RemotePreparationUncertain(`Windows browser loader preparation failed or its outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
  }
}
