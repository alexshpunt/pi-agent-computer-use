import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WINDOWS_POWERSHELL, runPowerShell, type CommandRunner } from "./runner.ts";
import { WINDOWS_NODE } from "./setup-pins.ts";
import { RemotePreparationUncertain } from "./remote-provision-error.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
// Node publishes a separate checksum for its standalone executable and its ZIP.
const NODE_EXE_VERSION = WINDOWS_NODE.version;
const NODE_EXE_SHA256 = WINDOWS_NODE.executableSha256;
type Manifest = { path: string; hash: string }[];

/** Every copied file participates in the cache key. Reject symlinks and names sha256sum cannot represent safely. */
async function manifest(source: string, playwright: string, signal?: AbortSignal): Promise<Manifest> {
  const files: Manifest = [];
  const visit = async (directory: string, prefix: string) => {
    signal?.throwIfAborted();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!/^[A-Za-z0-9_./@+ -]+$/.test(name)) throw new Error("Unsupported browser worker filename.");
      const file = path.join(directory, entry.name);
      const info = await lstat(file);
      if (info.isDirectory()) await visit(file, name);
      else if (info.isFile()) files.push({ path: name, hash: createHash("sha256").update(await readFile(file)).digest("hex") });
      else throw new Error(`Browser worker contains a non-regular file: ${name}`);
    }
  };
  await visit(path.join(source, "src"), "src");
  await visit(playwright, "node_modules/playwright-core");
  const packageFile = path.join(source, "package.json"), packageInfo = await lstat(packageFile);
  if (!packageInfo.isFile()) throw new Error("Browser worker package.json is not a regular file.");
  files.push({ path: "package.json", hash: createHash("sha256").update(await readFile(packageFile)).digest("hex") });
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

const exists = async (runner: CommandRunner, directory: string, signal?: AbortSignal) => {
  const out = await runner.run("bash", ["-c", 'if [ -e "$1" ] || [ -L "$1" ]; then printf present; else printf absent; fi', "worker-check", directory], { signal, timeoutMs: 30_000 });
  if (out !== "present" && out !== "absent") throw new Error("Could not determine remote browser worker state.");
  return out === "present";
};

/** Verify both the file set and every byte; never trust a copied manifest on the remote machine. */
async function verify(runner: CommandRunner, directory: string, files: Manifest, signal?: AbortSignal) {
  const list = await runner.run("bash", ["-c", 'set -eu; [ -d "$1" ] && [ ! -L "$1" ]; cd -- "$1"; if [ -n "$(find . ! -type f ! -type d -print -quit)" ]; then exit 1; fi; find . -type f -printf "%P\\n" | LC_ALL=C sort', "worker-verify", directory], { signal, timeoutMs: 120_000 });
  const names = list.trimEnd() ? list.trimEnd().split("\n") : [];
  if (names.length !== files.length || names.some((name, index) => name !== files[index].path)) throw new Error("Remote browser worker file set differs from the package.");
  await runner.run("bash", ["-c", 'set -eu; cd -- "$1"; sha256sum --check --strict --status', "worker-hash", directory],
    { input: files.map(file => `${file.hash}  ${file.path}\n`).join(""), signal, timeoutMs: 120_000 });
}

/** Stream one staged local archive over SSH; a cancelled or failed stream is never promoted. */
async function transfer(runner: CommandRunner, from: string, to: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const pack = spawn("tar", ["-cf", "-", "-C", from, "."], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let unpack: ReturnType<CommandRunner["spawn"]>;
  try { unpack = runner.spawn("tar", ["-xf", "-", "-C", to]); }
  catch (error) { pack.kill(); throw error; }
  let diagnostic = "";
  pack.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-1000); });
  unpack.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-1000); });
  const wait = (child: ChildProcess) => new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else { const error = new Error(`Browser worker transfer failed (${code}): ${diagnostic}`); Object.assign(error, { exitCode: code }); reject(error); }
    });
  });
  // Stop producing bytes on cancellation, but keep SSH alive until remote tar has seen EOF and exited.
  const onAbort = () => { pack.kill(); };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; pack.kill(); unpack.kill(); }, 180_000);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  pack.stdout.pipe(unpack.stdin);
  unpack.stdin.on("error", () => { /* The process exit below reports the transfer failure. */ });
  try {
    const [packed, unpacked] = await Promise.allSettled([wait(pack), wait(unpack)]);
    if (timedOut) throw new RemotePreparationUncertain("Browser worker transfer outcome is unknown; remote extraction may still be running.");
    if (unpacked.status === "rejected" && (runner.ssh && (unpacked.reason?.exitCode === 255 || unpacked.reason?.exitCode == null) || !signal?.aborted))
      throw new RemotePreparationUncertain(`Browser worker transfer outcome is unknown; remote extraction may still be running: ${String(unpacked.reason)}`);
    signal?.throwIfAborted();
    if (packed.status === "rejected") throw packed.reason;
    if (unpacked.status === "rejected") throw unpacked.reason;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

/** Copy the current worker into a content-addressed remote package; old workers remain untouched. */
export async function prepareWorkerPackage(runner: CommandRunner, source: string, playwright: string, home: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const files = await manifest(source, playwright, signal);
  const key = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const parent = path.posix.join(home, ".local/share/pi-computer-use/workers"), target = path.posix.join(parent, key);
  const resolvedParent = (await runner.run("realpath", ["-m", "--", parent], { signal, timeoutMs: 15_000 })).trim();
  if (resolvedParent !== parent) throw new Error("Remote browser worker cache parent is redirected.");
  if (await exists(runner, target, signal)) { await verify(runner, target, files, signal); return target; }
  await runner.run("mkdir", ["-p", "--", parent], { signal, timeoutMs: 30_000 });
  signal?.throwIfAborted();
  const stage = (await runner.run("mktemp", ["-d", `${parent}/.staging-XXXXXXXX`], { timeoutMs: 30_000 }).catch(error => { throw new RemotePreparationUncertain(`Remote staging outcome is unknown: ${error instanceof Error ? error.message : String(error)}`); })).trim();
  if (!stage.startsWith(`${parent}/.staging-`) || stage.slice(parent.length + 1).includes("/")) throw new Error("Invalid remote staging directory.");
  let local: string | undefined;
  try {
    local = await mkdtemp(path.join(tmpdir(), "pi-remote-browser-"));
    await mkdir(path.join(local, "node_modules"));
    await cp(path.join(source, "src"), path.join(local, "src"), { recursive: true });
    await cp(playwright, path.join(local, "node_modules", "playwright-core"), { recursive: true });
    await cp(path.join(source, "package.json"), path.join(local, "package.json"));
    await transfer(runner, local, stage, signal);
    await verify(runner, stage, files, signal);
    signal?.throwIfAborted();
    // GNU mv -T -n never replaces an existing published directory. A racing winner is verified below.
    try { await runner.run("mv", ["-T", "-n", "--", stage, target], { timeoutMs: 30_000 }); }
    catch (error) {
      if (!await exists(runner, target).catch(() => false)) throw new RemotePreparationUncertain(`Remote browser worker publication outcome is unknown: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (signal?.aborted) throw new RemotePreparationUncertain("Cancelled after remote worker publication; the cache may already be present.");
    await verify(runner, target, files, signal);
    return target;
  } finally {
    const cleanup = await Promise.allSettled([...(local ? [rm(local, { recursive: true, force: true })] : []), runner.run("rm", ["-rf", "--", stage], { timeoutMs: 30_000 })]);
    if (cleanup.some(result => result.status === "rejected")) throw new RemotePreparationUncertain(`Browser worker staging cleanup is unconfirmed: ${stage}`);
  }
}

/** Find a compatible Windows Node or install the verified standalone executable in an owned cache. */
export async function prepareWindowsNode(runner: CommandRunner, signal?: AbortSignal): Promise<string> {
  const url = `https://nodejs.org/dist/${NODE_EXE_VERSION}/win-x64/node.exe`;
  const ps = `
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Hash([string]$f) { $s = [IO.File]::OpenRead($f); try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) } finally { $s.Dispose() } }
function ValidNode([string]$f) {
  if (!(Test-Path -LiteralPath $f -PathType Leaf)) { return $false }
  try { $v = (& $f --version 2>$null); $a = (& $f -p 'process.arch' 2>$null); if ($v -notmatch '^v(\\d+)\\.(\\d+)\\.') { return $false }; $major = [int]$Matches[1]; $minor = [int]$Matches[2]; return $a -eq 'x64' -and ($major -ge 24 -or ($major -eq 23 -and $minor -ge 6) -or ($major -eq 22 -and $minor -ge 19)) } catch { return $false }
}
$installed = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if ($installed -and (ValidNode $installed)) { $installed; return }
$legacy = Join-Path $env:LOCALAPPDATA 'Programs\\PiComputerUse\\node-${NODE_EXE_VERSION}-win-x64\\node.exe'
if ((Test-Path -LiteralPath $legacy -PathType Leaf) -and (Hash $legacy) -eq '${NODE_EXE_SHA256}') { $legacy; return }
$root = Join-Path $env:LOCALAPPDATA 'PiComputerUse\\browser-node'
$dir = Join-Path $root '${NODE_EXE_SHA256}'
$exe = Join-Path $dir 'node.exe'
if (Test-Path -LiteralPath $dir) {
  if (((Get-Item -Force -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) -or !(Test-Path -LiteralPath $exe -PathType Leaf) -or (Hash $exe) -ne '${NODE_EXE_SHA256}') { throw 'Cached Windows Node does not match the package.' }
  $exe; return
}
New-Item -ItemType Directory -Force -Path $root | Out-Null
$stage = Join-Path $root ('.staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $download = Join-Path $stage 'node.exe'
  (New-Object Net.WebClient).DownloadFile('${url}', $download)
  if ((Hash $download) -ne '${NODE_EXE_SHA256}') { throw 'Windows Node download failed integrity verification.' }
  try { [IO.Directory]::Move($stage, $dir) } catch { if (!(Test-Path -LiteralPath $dir)) { throw } }
  if (((Get-Item -Force -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) -or !(Test-Path -LiteralPath $exe -PathType Leaf) -or (Hash $exe) -ne '${NODE_EXE_SHA256}') { throw 'Cached Windows Node does not match the package.' }
  $exe
} finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force } }`;
  signal?.throwIfAborted();
  let windows: string;
  try { windows = await runPowerShell(runner, WINDOWS_POWERSHELL, ps, { timeoutMs: 600_000, scriptOnStdin: true }); }
  catch (error) { throw new RemotePreparationUncertain(`Windows Node preparation outcome is unknown; a remote installer may still be running: ${error instanceof Error ? error.message : String(error)}`); }
  if (!/^[A-Za-z]:\\/.test(windows)) throw new Error("Windows Node path is invalid.");
  if (signal?.aborted) throw new Error("Cancelled after Windows Node was prepared; its verified cache remains available.");
  return (await runner.run("wslpath", ["-u", windows], { signal, timeoutMs: 30_000 })).trim();
}

/** Prepare only the worker; a user-supplied Node must not trigger another Node installation. */
export async function prepareRemoteWorker(runner: CommandRunner, signal?: AbortSignal): Promise<string> {
  const home = (await runner.run("bash", ["-c", 'printf %s "$HOME"'], { signal, timeoutMs: 30_000 })).trim();
  if (!home.startsWith("/") || home.includes("\n")) throw new Error("Remote home directory is invalid.");
  const playwright = path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
  return prepareWorkerPackage(runner, packageRoot, playwright, home, signal);
}

/** Provision the missing browser parts; explicit overrides are left untouched. */
export async function prepareRemoteBrowser(runner: CommandRunner, signal?: AbortSignal,
  overrides: { node?: string; package?: string } = {}, deps = { node: prepareWindowsNode, worker: prepareRemoteWorker }): Promise<{ node: string; package: string }> {
  const [node, remotePackage] = await Promise.allSettled([
    overrides.node ? Promise.resolve(overrides.node) : deps.node(runner, signal),
    overrides.package ? Promise.resolve(overrides.package) : deps.worker(runner, signal),
  ]);
  if (node.status === "rejected" && node.reason instanceof RemotePreparationUncertain) throw node.reason;
  if (remotePackage.status === "rejected" && remotePackage.reason instanceof RemotePreparationUncertain) throw remotePackage.reason;
  if (node.status === "rejected") throw node.reason;
  if (remotePackage.status === "rejected") throw remotePackage.reason;
  return { node: node.value, package: remotePackage.value };
}
