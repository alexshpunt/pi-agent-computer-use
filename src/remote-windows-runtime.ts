import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BundledRuntime } from "./native-runtime.ts";
import { RemotePreparationUncertain } from "./remote-provision-error.ts";
import { psString, runnerFiles, runPowerShell, type CommandRunner } from "./runner.ts";

/** Shared helpers of the PowerShell steps; the request arrives as JSON on the input. */
const COMMON = `
function Get-Sha256([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Dispose() }
}
# A cache must stay beneath the user's folder: a redirected directory or file is refused.
function Test-Plain([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  [bool]($item -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))
}
$spec = [Console]::In.ReadToEnd() | ConvertFrom-Json
$parent = Join-Path $env:LOCALAPPDATA ('PiComputerUse\\native-runtimes\\' + $spec.source + '\\' + $spec.identity)
$destination = Join-Path $parent $spec.target
# The names whose file is missing, redirected or does not match its pin; callers wrap the result in @().
function Get-Bad([string]$Root) {
  foreach ($entry in $spec.files.PSObject.Properties) {
    $file = Join-Path $Root ('runtime\\' + $entry.Name)
    if (-not (Test-Plain $file) -or (Get-Item -LiteralPath $file -Force).PSIsContainer -or (Get-Sha256 $file) -ne $entry.Value) { $entry.Name }
  }
}
`;

/** Check a published runtime: present and every file matches, or absent. */
const STATUS = `
if (-not (Test-Path -LiteralPath $destination)) { @{ present = $false; destination = $destination } | ConvertTo-Json -Compress; return }
if (-not (Test-Plain $parent) -or -not (Test-Plain $destination) -or -not (Test-Plain (Join-Path $destination 'runtime'))) { throw 'remote_runtime_cache_symlink_refused' }
@{ present = $true; destination = $destination; bad = @(Get-Bad $destination) } | ConvertTo-Json -Compress`;

/**
 * Make a staging folder and fetch what the machine can download itself: each file arrives under a temporary name and
 * takes its own name only when its hash matches. The script stops its own downloads before the SSH call times out.
 */
const STAGE = `
New-Item -ItemType Directory -Force -Path $parent | Out-Null
if (-not (Test-Plain $parent)) { throw 'remote_runtime_cache_symlink_refused' }
$staging = Join-Path $parent ('.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path (Join-Path $staging 'runtime') | Out-Null
if ($spec.url) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $end = (Get-Date).AddSeconds(540)
  foreach ($entry in $spec.files.PSObject.Properties) {
    if ((Get-Date) -ge $end) { break }
    $file = Join-Path $staging ('runtime\\' + $entry.Name)
    try {
      (New-Object Net.WebClient).DownloadFile($spec.url + $entry.Name, $file + '.part')
      if ((Get-Sha256 ($file + '.part')) -eq $entry.Value) { Move-Item -LiteralPath ($file + '.part') -Destination $file } else { Remove-Item -LiteralPath ($file + '.part') -Force }
    } catch { Remove-Item -LiteralPath ($file + '.part') -Force -ErrorAction SilentlyContinue }
  }
}
@{ staging = $staging; bad = @(Get-Bad $staging) } | ConvertTo-Json -Compress`;

/** Check the staged files, publish the folder without replacing a published one, and check the result. */
const PUBLISH = `
$staging = $spec.staging
if ($staging -notlike ($parent + '\\.staging-*')) { throw 'remote_runtime_staging_invalid' }
try {
  if (@(Get-Bad $staging).Count) { throw 'remote_runtime_hash_mismatch: the staged runtime does not match the package' }
  # A concurrent publisher may have won; either copy is the pinned one, which the check below confirms.
  try { Move-Item -LiteralPath $staging -Destination $destination } catch { if (-not (Test-Path -LiteralPath $destination)) { throw } }
  if (-not (Test-Plain $destination) -or -not (Test-Plain (Join-Path $destination 'runtime')) -or @(Get-Bad $destination).Count) { throw 'remote_runtime_hash_mismatch: existing remote runtime was not replaced' }
} finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue } }
Join-Path $destination 'runtime\\cua-driver.exe'`;

/**
 * Copy the checked package runtime to an immutable cache in the Windows user's folder of a machine without WSL and
 * return its driver as a Windows path. The machine first downloads the pinned release files itself; a file that does
 * not arrive or does not match its pinned hash is streamed from here. `direct` is the machine's SSH login session.
 */
export async function installRemoteWindowsRuntime(direct: CommandRunner, runtime: BundledRuntime, identity: string, url: string | undefined): Promise<string> {
  const names = Object.keys(runtime.files).sort();
  const request = (extra: Record<string, unknown> = {}) => JSON.stringify({ source: runtime.source, identity, target: runtime.target, files: runtime.files, ...(url ? { url } : {}), ...extra });
  const step = (script: string, extra?: Record<string, unknown>, timeoutMs = 120_000) =>
    runPowerShell(direct, "powershell.exe", COMMON + script, { input: request(extra), timeoutMs });
  const status = JSON.parse(await step(STATUS)) as { present: boolean; destination: string; bad?: string[] };
  if (status.present) {
    if (status.bad?.length) throw new Error("remote_runtime_hash_mismatch: existing remote runtime was not replaced");
    return `${status.destination}\\runtime\\cua-driver.exe`;
  }
  let staged: { staging: string; bad: string[] };
  try { staged = JSON.parse(await step(STAGE, undefined, 600_000)) as { staging: string; bad: string[] }; }
  catch (error) { throw new RemotePreparationUncertain(`Remote runtime staging or download outcome is unknown; a remote download may still be running: ${error instanceof Error ? error.message : String(error)}`); }
  let failure: unknown;
  try {
    for (const name of names.filter(file => staged.bad.includes(file))) {
      const bytes = await readFile(path.join(runtime.root, "runtime", name));
      // Keep SSH open until the dispatched writer exits. Killing the local client does not prove the remote writer stopped.
      try {
        await runnerFiles(direct).write(`${staged.staging}\\runtime\\${name}`, bytes);
      } catch (error) { throw new RemotePreparationUncertain(`Remote runtime transfer outcome is unknown; a remote writer may still be running: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try { return await step(PUBLISH, { staging: staged.staging }, 120_000); }
    catch (error) {
      if (error instanceof Error && error.message.includes("remote_runtime_")) throw error;
      throw new RemotePreparationUncertain(`Remote runtime publication outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) { failure = error; }
  // PUBLISH removes its staging folder itself; after an earlier failure nothing else will.
  try { await runPowerShell(direct, "powershell.exe", `Remove-Item -LiteralPath ${psString(staged.staging)} -Recurse -Force -ErrorAction SilentlyContinue`, { timeoutMs: 30_000 }); }
  catch (error) { throw new RemotePreparationUncertain(`Remote runtime staging cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`, { cause: failure }); }
  throw failure;
}
