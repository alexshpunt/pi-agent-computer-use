import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadComputerConfig, readMachineSettings, type MachineConfig } from "./config.ts";
import { PACKAGED_RUNTIME, fetchRuntime, isWsl, loadBundledRuntime, readRuntimePins } from "./native-runtime.ts";
import { WINDOWS_POWERSHELL, localRunner, runPowerShell, sshRunner, type CommandRunner } from "./runner.ts";
import { MXC, PERCEPTION, WINDOWS_NODE } from "./setup-pins.ts";
import { findWindowsNode } from "./windows-node.ts";

/** Optional parts and what each adds; `machine` prepares another machine instead of installing on one. */
export const SETUP_PARTS = [
  { name: "browser", description: "Windows Node for open_browser and attach_browser when Pi runs in WSL (about 30 MB)" },
  { name: "firefox", description: "Playwright's Firefox for \"browser\":\"firefox\"" },
  { name: "perception", description: "Cua perception for the regions view (about 420 MB, AGPL-3.0 icon detector)" },
  { name: "mxc", description: "Microsoft MXC for open_session (Windows 11 24H2 or later)" },
  { name: "vscode-bridge", description: "Pi Browser Bridge for VS Code's integrated browser" },
  { name: "machine", description: "Prepare another Windows machine with WSL, reached over SSH" },
] as const;
export type SetupPart = (typeof SETUP_PARTS)[number]["name"];

export interface SetupRequest {
  part: SetupPart;
  /** A configured machine name; this machine when omitted or "local". Not used by `machine`. */
  machine?: string;
  /** For `machine`: the SSH alias and the name to configure it under. */
  ssh?: string;
  name?: string;
  /** For `vscode-bridge` with a portable VS Code: its bin\code.cmd and data\argv.json on the target. */
  code?: string;
  argv?: string;
}

/** Thrown for a request that cannot start; nothing was installed. */
export class SetupError extends Error {}

/** The Windows machine a part installs on, and how its commands run. */
interface Target {
  label: string;
  runner: CommandRunner;
  /** PowerShell as the runner sees it. */
  powershell: string;
  /** Pi itself runs on this Windows: paths are Windows paths and no WSL is involved. */
  native: boolean;
  machine?: MachineConfig;
  /** WSL interop socket from the trusted settings. */
  interop?: string;
}

export interface SetupDeps {
  platform: NodeJS.Platform;
  wsl: () => Promise<boolean>;
  local: (interop?: string) => CommandRunner;
  ssh: (alias: string) => CommandRunner;
}
const defaultDeps: SetupDeps = { platform: process.platform, wsl: isWsl, local: localRunner, ssh: sshRunner };

type Progress = (message: string) => void;
const BRIDGE_ID = "alexshpunt.pi-browser-bridge";
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Downloads are checked on the target before use; native tools print their own output, and their failure stops
 * the script with that output. tar.exe ships with Windows 10 and later and unpacks zip much faster than .NET ZipFile.
 */
const PRELUDE = `
# A WSL working directory is a UNC path that cmd-based tools such as code.cmd cannot use.
Set-Location -LiteralPath $env:TEMP
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# .NET directly: Get-FileHash and Expand-Archive come from script modules that some PowerShell setups fail to load,
# and WebClient downloads far faster than Invoke-WebRequest in Windows PowerShell.
function Get-Sha256([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $stream.Dispose() }
}
function Get-Pinned([string]$Url, [string]$File, [string]$Sha256) {
  if ((Test-Path -LiteralPath $File) -and (Get-Sha256 $File) -eq $Sha256) { return }
  (New-Object Net.WebClient).DownloadFile($Url, $File)
  if ((Get-Sha256 $File) -ne $Sha256) {
    Remove-Item -LiteralPath $File -Force
    throw "The download from $Url does not match its pinned SHA-256; nothing was installed."
  }
}
function Invoke-Native([string]$Exe, [string[]]$Arguments, [switch]$AllowFailure) {
  $ErrorActionPreference = 'Continue'
  $out = (& $Exe @Arguments 2>&1 | ForEach-Object { "$_" }) -join [Environment]::NewLine
  if ($LASTEXITCODE -ne 0 -and !$AllowFailure) { throw ([IO.Path]::GetFileName($Exe) + " exited with $($LASTEXITCODE): " + $out) }
  $out
}
function Expand-Zip([string]$Zip, [string]$Destination) {
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\\tar.exe'
  if (Test-Path -LiteralPath $tar) { Invoke-Native $tar @('-xf', $Zip, '-C', $Destination) | Out-Null }
  else { Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination) }
}
`;

const ps = (target: Target, script: string, timeoutMs: number, signal?: AbortSignal) =>
  runPowerShell(target.runner, target.powershell, PRELUDE + script, { timeoutMs, scriptOnStdin: true, ...(signal ? { signal } : {}) });

/** A Windows path on the target as its runner addresses files. */
async function targetPath(target: Target, windows: string): Promise<string> {
  return target.native ? windows : (await target.runner.run("wslpath", ["-u", windows])).trim();
}

/** A target path (Windows, or the target's WSL path) as Windows sees it. */
async function windowsPath(target: Target, value: string): Promise<string> {
  return target.native || /^[A-Za-z]:\\/.test(value) ? value : (await target.runner.run("wslpath", ["-w", value])).trim();
}

/** Write bytes to a Windows path on the target. */
async function put(target: Target, windows: string, bytes: Buffer): Promise<void> {
  const file = await targetPath(target, windows);
  if (!target.machine) await writeFile(file, bytes);
  else await target.runner.run("dd", ["status=none", `of=${file}`], { input: bytes, timeoutMs: 600_000 });
}

async function resolveTarget(cwd: string, machine: string | undefined, deps: SetupDeps): Promise<Target> {
  const settings = await readMachineSettings(cwd);
  if (machine && machine !== "local") {
    const config = settings.machines[machine];
    if (!config) throw new SetupError(`No machine named ${machine} is configured in .pi/computer-use.json; nothing was installed.`);
    return { label: `machine ${machine}`, runner: deps.ssh(config.ssh), powershell: WINDOWS_POWERSHELL, native: false, machine: config };
  }
  if (deps.platform === "win32") return { label: "this machine", runner: deps.local(), powershell: "powershell.exe", native: true };
  // Pi in WSL: Windows reached through interop.
  if (deps.platform === "linux" && await deps.wsl())
    return { label: "this machine", runner: deps.local(settings.interop), powershell: WINDOWS_POWERSHELL, native: false, ...(settings.interop ? { interop: settings.interop } : {}) };
  throw new SetupError("Setup needs Pi on Windows or in WSL; nothing was installed.");
}

/** Install the pinned portable Node on the target and return its node.exe as a Windows path. */
async function installNode(target: Target, signal?: AbortSignal): Promise<{ exe: string; installed: boolean }> {
  const name = `node-${WINDOWS_NODE.version}-win-x64`;
  const out = await ps(target, `
$root = Join-Path $env:LOCALAPPDATA 'Programs\\PiComputerUse'
$exe = Join-Path $root ${psString(`${name}\\node.exe`)}
if (Test-Path -LiteralPath $exe) { 'present'; $exe; return }
New-Item -ItemType Directory -Force -Path $root | Out-Null
$zip = Join-Path $env:TEMP ${psString(`pi-${name}.zip`)}
Get-Pinned ${psString(WINDOWS_NODE.url)} $zip ${psString(WINDOWS_NODE.sha256)}
$stage = Join-Path $root ('.staging-' + [guid]::NewGuid())
Expand-Zip $zip $stage
Move-Item -LiteralPath (Join-Path $stage ${psString(name)}) -Destination $root
Remove-Item -LiteralPath $stage, $zip -Recurse -Force
'installed'; $exe`, 600_000, signal);
  const [state, exe] = out.split("\n").slice(-2);
  return { exe, installed: state === "installed" };
}

async function browser(target: Target, signal?: AbortSignal): Promise<string> {
  if (target.native) return "Pi runs on Windows here, so browsers use Pi's own Node. Nothing to install.";
  const node = await installNode(target, signal);
  return node.installed ? `Installed Windows Node ${WINDOWS_NODE.version} on ${target.label}: ${node.exe}` : `Windows Node is already installed on ${target.label}: ${node.exe}`;
}

function needsBrowserCopy(target: Target): never {
  throw new SetupError(`${target.label} has no browser worker yet; prepare it with setup part machine (ssh ${target.machine!.ssh}) first. Nothing was installed.`);
}

async function firefox(target: Target, signal?: AbortSignal): Promise<string> {
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "cli.js");
  let node: string, script: string;
  if (target.machine) {
    if (!target.machine.node || !target.machine.package) needsBrowserCopy(target);
    node = target.machine.node;
    script = await windowsPath(target, `${target.machine.package}/node_modules/playwright-core/cli.js`);
  } else if (target.native) { node = process.execPath; script = cli; }
  else {
    node = await findWindowsNode(target.interop)
      .catch(error => { throw new SetupError(`${error instanceof Error ? error.message : error} Firefox needs it too; install browser first.`); });
    script = await windowsPath(target, cli);
  }
  const out = await target.runner.run(node, [script, "install", "firefox"], { timeoutMs: 900_000, ...(signal ? { signal } : {}) });
  return `Playwright's Firefox is ready on ${target.label}.${tail(out)}`;
}

async function perception(target: Target, cwd: string, signal?: AbortSignal): Promise<string> {
  const driver = await windowsPath(target, target.machine ? target.machine.command : (await loadComputerConfig(cwd)).command);
  const { name, release, catalog, archive, version } = PERCEPTION;
  const out = await ps(target, `
$driver = ${psString(driver)}
$status = Invoke-Native $driver @('extension', 'status', 'perception') -AllowFailure
if ($status -notmatch ${psString(`Active version: ${version.replace(/\./g, "\\.")}`)}) {
  $dir = Join-Path $env:TEMP 'pi-perception'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $catalog = Join-Path $dir ${psString(`${name}.catalog.json`)}
  Get-Pinned ${psString(`${release}${name}.catalog.json`)} $catalog ${psString(catalog)}
  Get-Pinned ${psString(`${release}${name}.tar.gz`)} (Join-Path $dir ${psString(`${name}.tar.gz`)}) ${psString(archive)}
  Invoke-Native $driver @('extension', 'install', 'perception', '--catalog', $catalog)
  Remove-Item -LiteralPath $dir -Recurse -Force
}
Invoke-Native $driver @('extension', 'status', 'perception', '--self-test')`, 2_400_000, signal);
  return `Cua perception ${version} is ready on ${target.label}.${tail(out)}`;
}

async function mxc(target: Target, signal?: AbortSignal): Promise<string> {
  const out = await ps(target, `
$dir = Join-Path $env:LOCALAPPDATA 'PiComputerUse\\mxc'
$zip = Join-Path $env:TEMP ${psString(`pi-mxc-${MXC.version}.zip`)}
Get-Pinned ${psString(MXC.url)} $zip ${psString(MXC.sha256)}
$stage = Join-Path $env:TEMP ('pi-mxc-' + [guid]::NewGuid())
Expand-Zip $zip $stage
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -LiteralPath (Join-Path $stage 'x64\\wxc-exec.exe') -Destination $dir -Force
Remove-Item -LiteralPath $stage, $zip -Recurse -Force
Join-Path $dir 'wxc-exec.exe'`, 600_000, signal);
  return `Installed MXC ${MXC.version} on ${target.label}: ${out.split("\n").at(-1)}`;
}

/** Add the bridge to VS Code's argv.json (JSONC) without rewriting the rest; undefined when it is already allowed. */
export function allowProposedApi(text: string, id = BRIDGE_ID): string | undefined {
  if (text.includes(id)) return undefined;
  if (!text.trim()) text = "{\n}\n";
  // Whether only whitespace and comments come before the closing bracket, so no separating comma is needed.
  const empty = (rest: string, close: string) => rest.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|\s/g, "").startsWith(close);
  const list = /"enable-proposed-api"\s*:\s*\[/.exec(text);
  if (list) {
    const at = list.index + list[0].length;
    return text.slice(0, at) + JSON.stringify(id) + (empty(text.slice(at), "]") ? "" : ", ") + text.slice(at);
  }
  const brace = text.indexOf("{") + 1;
  if (!brace) throw new SetupError("VS Code's argv.json has no JSON object; fix or remove it, then run setup again.");
  return `${text.slice(0, brace)}\n\t"enable-proposed-api": [${JSON.stringify(id)}]${empty(text.slice(brace), "}") ? "" : ","}${text.slice(brace)}`;
}

/** Run a command on the machine where Pi runs; npm and npx are .cmd files on Windows. */
function local(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, { cwd, shell: process.platform === "win32", timeout: 600_000, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
    (error, stdout, stderr) => error ? reject(new Error(`${command} ${args[0]} failed: ${(stderr || error.message).trim().slice(-800)}`)) : resolve(stdout)));
}

/** Package the bridge with its ws dependency into a .vsix. */
async function buildBridge(signal?: AbortSignal): Promise<Buffer> {
  const work = await mkdtemp(path.join(tmpdir(), "pi-browser-bridge-"));
  try {
    for (const file of ["package.json", "extension.js", "README.md"]) await copyFile(path.join(PACKAGE, "vscode-browser-bridge", file), path.join(work, file));
    await local("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--silent"], work, signal);
    await local("npx", ["--yes", "@vscode/vsce@4.0.0", "package", "--skip-license", "-o", "pi-browser-bridge.vsix"], work, signal);
    return await readFile(path.join(work, "pi-browser-bridge.vsix"));
  } finally { await rm(work, { recursive: true, force: true }); }
}

async function vscodeBridge(target: Target, request: SetupRequest, signal?: AbortSignal): Promise<string> {
  if (!request.code !== !request.argv) throw new SetupError("For a portable VS Code pass both its bin\\code.cmd and its data\\argv.json; nothing was installed.");
  const vsix = await buildBridge(signal);
  const temp = await ps(target, "$env:TEMP", 30_000, signal);
  const file = `${temp}\\pi-browser-bridge.vsix`;
  await put(target, file, vsix);
  const code = request.code ? await windowsPath(target, request.code) : "";
  const argv = request.argv ? await windowsPath(target, request.argv) : "";
  const found = await ps(target, `
$code = ${psString(code)}
if (!$code) {
  foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'Programs\\Microsoft VS Code\\bin\\code.cmd'), (Join-Path $env:ProgramFiles 'Microsoft VS Code\\bin\\code.cmd'))) {
    if (Test-Path -LiteralPath $candidate) { $code = $candidate; break }
  }
}
if (!$code) { throw 'No installed VS Code found. For a portable VS Code pass its bin\\code.cmd and data\\argv.json.' }
$argv = ${psString(argv)}
if (!$argv) { $argv = Join-Path $env:USERPROFILE '.vscode\\argv.json' }
Invoke-Native $code @('--install-extension', ${psString(file)}, '--force') | Out-Null
Remove-Item -LiteralPath ${psString(file)} -Force
$text = if (Test-Path -LiteralPath $argv) { [IO.File]::ReadAllText($argv) } else { '' }
$code
$argv
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))`, 300_000, signal);
  const [codeCmd, argvJson, encoded] = found.split("\n").slice(-3);
  const next = allowProposedApi(Buffer.from(encoded, "base64").toString("utf8"));
  if (next !== undefined) await ps(target, `
$argv = ${psString(argvJson)}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $argv) | Out-Null
[IO.File]::WriteAllText($argv, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${psString(Buffer.from(next).toString("base64"))})), (New-Object Text.UTF8Encoding $false))`, 30_000, signal);
  return `Installed the Pi Browser Bridge into ${codeCmd} on ${target.label}. ${argvJson} ${next === undefined ? "already allows" : "now allows"} its proposed API. Quit VS Code fully and start it again; Reload Window does not reread argv.json.`;
}

/** Stream a local folder into a fresh folder on the remote WSL through tar. */
async function copyTree(runner: CommandRunner, from: string, to: string): Promise<void> {
  await runner.run("rm", ["-rf", to]);
  await runner.run("mkdir", ["-p", to]);
  await new Promise<void>((resolve, reject) => {
    const remote = runner.spawn("tar", ["-x", "-f", "-", "-C", to]);
    const pack = spawn("tar", ["-c", "-f", "-", "-C", from, "."], { stdio: ["ignore", "pipe", "pipe"] });
    let failed = "";
    pack.stderr.on("data", chunk => { failed += chunk; });
    remote.stderr.on("data", chunk => { failed += chunk; });
    pack.stdout.pipe(remote.stdin);
    pack.on("error", reject);
    remote.on("error", reject);
    remote.on("close", code => code === 0 ? resolve() : reject(new Error(`Copying ${path.basename(from)} failed: ${failed.trim().slice(-500)}`)));
  });
}

async function prepareMachine(request: SetupRequest, deps: SetupDeps, progress: Progress, signal?: AbortSignal): Promise<string> {
  const alias = request.ssh;
  if (!alias || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(alias)) throw new SetupError("machine needs the SSH alias of a Windows machine with WSL; nothing was installed.");
  const name = request.name ?? alias;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || name === "local") throw new SetupError("The machine name must be letters, digits, - or _, and not local.");
  const target: Target = { label: `machine ${name}`, runner: deps.ssh(alias), powershell: WINDOWS_POWERSHELL, native: false, machine: { ssh: alias, command: "" } };
  const { runner } = target;

  progress("checking the local runtime");
  const pins = await readRuntimePins();
  await fetchRuntime(PACKAGED_RUNTIME, pins, signal);
  const runtime = await loadBundledRuntime(PACKAGED_RUNTIME, pins);
  progress("copying the driver");
  const appData = await targetPath(target, await ps(target, "$env:LOCALAPPDATA", 30_000, signal));
  const folder = `${appData}/Programs/PiComputerUse/cua-driver-${pins.version}-${pins.source.slice(0, 8)}/runtime`;
  await runner.run("mkdir", ["-p", folder]);
  const names = Object.keys(pins.files);
  for (const file of names) await runner.run("dd", ["status=none", `of=${folder}/${file}`], { input: await readFile(path.join(runtime.root, "runtime", file)), timeoutMs: 600_000 });
  const sums = (await runner.run("sha256sum", names.map(file => `${folder}/${file}`))).trim().split("\n").map(line => line.split(" ")[0]);
  const bad = names.filter((file, index) => sums[index] !== pins.files[file]);
  if (bad.length) throw new SetupError(`The copied driver files do not match their pins (${bad.join(", ")}).`);

  progress("installing Windows Node");
  const node = await targetPath(target, (await installNode(target, signal)).exe);
  progress("copying the browser worker");
  const home = (await runner.run("bash", ["-c", 'printf %s "$HOME"'])).trim();
  const remotePackage = `${home}/.local/share/pi-computer-use/package`;
  await copyTree(runner, path.join(PACKAGE, "src"), `${remotePackage}/src`);
  await copyTree(runner, path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), `${remotePackage}/node_modules/playwright-core`);
  await runner.run("dd", ["status=none", `of=${remotePackage}/package.json`], { input: await readFile(path.join(PACKAGE, "package.json")) });

  const entry = { ssh: alias, runtime: "windows-desktop", command: `${folder}/cua-driver.exe`, node, package: remotePackage };
  return `Prepared ${alias} for computer use. Add this under "machines" in .pi/computer-use.json:\n${JSON.stringify({ [name]: entry }, null, 2)}`;
}

const tail = (out: string) => {
  const lines = out.replace(/\r/g, "").split("\n").map(line => line.trimEnd()).filter(Boolean);
  return lines.length ? `\n${lines.slice(-8).join("\n")}` : "";
};

/** Install one optional part on this machine or a configured one, or prepare another machine. */
export async function runSetup(request: SetupRequest, cwd: string, options: { progress?: Progress; signal?: AbortSignal; deps?: Partial<SetupDeps> } = {}): Promise<string> {
  const deps = { ...defaultDeps, ...options.deps };
  const progress = options.progress ?? (() => undefined);
  if (!SETUP_PARTS.some(part => part.name === request.part)) throw new SetupError(`Unknown part ${request.part}. Parts: ${SETUP_PARTS.map(part => part.name).join(", ")}.`);
  if (request.part === "machine") return prepareMachine(request, deps, progress, options.signal);
  const target = await resolveTarget(cwd, request.machine, deps);
  progress(`working on ${target.label}`);
  switch (request.part) {
    case "browser": return browser(target, options.signal);
    case "firefox": return firefox(target, options.signal);
    case "perception": return perception(target, cwd, options.signal);
    case "mxc": return mxc(target, options.signal);
    case "vscode-bridge": return vscodeBridge(target, request, options.signal);
  }
}
