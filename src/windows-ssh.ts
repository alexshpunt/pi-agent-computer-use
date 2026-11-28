import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SSH_OPTIONS, execute, psString, runPowerShell, type CommandRunner } from "./runner.ts";

/**
 * A Windows machine reached over SSH without WSL. Windows OpenSSH starts every login in the services session, which
 * has no desktop: a driver started there sees no windows. A small helper (native/session-host) therefore runs in the
 * user's interactive session, started through a one-shot Interactive scheduled task of the same user, and starts the
 * driver and its cooperating processes there with their standard streams bridged over a named pipe. The pipe is
 * usable by that user alone and refuses network clients; nothing listens on a TCP port.
 *
 * The SSH command is the helper's own console program, not PowerShell: Windows PowerShell does not pass a redirected
 * standard input on as it arrives, so a stream that stays open, such as the driver's, would never reach the program.
 */
const CSC_FLAGS = "/nologo /platform:x64 /optimize+ /r:System.dll /r:System.Core.dll /r:System.Web.Extensions.dll";
const HOST_EXE = "pi-session-host.exe";
const CLIENT_EXE = "pi-session-client.exe";
const START_SCRIPT = "session-start.ps1";

const IDENTITY_SCRIPT = "window-identity.ps1";

interface Sources { source: string; start: string; identity: string; version: string }
let sources: Sources | undefined;
/** The helper's sources and the version that names its install folder. */
export function sessionHostSources(): Sources {
  if (!sources) {
    const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
    const source = read("../native/session-host/SessionHost.cs"), start = read(`../scripts/${START_SCRIPT}`), identity = read(`../scripts/${IDENTITY_SCRIPT}`);
    const hash = createHash("sha256").update(CSC_FLAGS);
    for (const part of [source, start, identity]) hash.update("\0").update(part);
    sources = { source, start, identity, version: hash.digest("hex").slice(0, 16) };
  }
  return sources;
}

/**
 * The window identity peer's script on the machine, beside the helper. It is too long for a command line, and a script
 * run from a file needs no encoding. Installed by prepareSessionHost.
 */
export function identityScriptPath(alias: string): string {
  return `${folderOf(alias)}\\${IDENTITY_SCRIPT}`;
}

const HELPER_ROOT = "PiComputerUse\\session-host";

/** One program for the helper to start in the interactive session. */
export interface SessionRequest { file: string; args: readonly string[]; env?: Record<string, string> }

/** Tokens that mean the same to cmd.exe and PowerShell, whichever the machine's login shell is. */
const SAFE_TOKEN = /^[A-Za-z0-9_.:\\/=+,@~-]+$/;

/** The folder of the installed helper per machine, as a path without spaces; set by prepareSessionHost. */
const folders = new Map<string, string>();
function folderOf(alias: string): string {
  const folder = folders.get(alias);
  if (!folder) throw new Error(`The session helper of machine ${alias} is not prepared yet.`);
  return folder;
}

/** The pipe name of one Pi process for one machine; each Pi process gets its own helper, which leaves when idle. */
const pipes = new Map<string, string>();
function pipeName(alias: string): string {
  let name = pipes.get(alias);
  if (!name) pipes.set(alias, name = `pi-computer-use-${randomUUID()}`);
  return name;
}

/**
 * The remote command line of one helper call. It is a program path and plain tokens, so cmd.exe and PowerShell, whichever
 * is the machine's login shell, read it the same way. The request travels as base64 in the command line.
 */
export function clientCommand(alias: string, request: SessionRequest | "ensure"): string {
  const program = `${folderOf(alias)}\\${CLIENT_EXE}`;
  if (request === "ensure") return [program, "ensure", pipeName(alias)].join(" ");
  return [program, "run", pipeName(alias), Buffer.from(JSON.stringify(request), "utf8").toString("base64")].join(" ");
}

/** ssh arguments that run a request through the helper; for a caller that spawns ssh itself, such as the MCP transport. */
export function sessionSshArguments(alias: string, request: SessionRequest): string[] {
  return [...SSH_OPTIONS, alias, clientCommand(alias, request)];
}

/**
 * Runs in the SSH login session itself (no desktop): for installing and checking files. A program and its arguments
 * must be plain tokens; scripts travel as -EncodedCommand.
 */
export function directWindowsRunner(alias: string): CommandRunner {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(alias)) throw new Error("Invalid SSH alias.");
  const args = (file: string, rest: readonly string[]) => {
    if (![file, ...rest].every(token => SAFE_TOKEN.test(token))) throw new Error("This command cannot be passed to a Windows login shell safely.");
    return [...SSH_OPTIONS, alias, [file, ...rest].join(" ")];
  };
  return {
    ssh: alias, windows: true,
    spawn: (file, rest) => spawn("ssh", args(file, rest), { stdio: "pipe" }),
    run: (file, rest, options = {}) => execute("ssh", args(file, rest), process.env, options),
  };
}

/**
 * Runs programs in the interactive session of a Windows machine reached over SSH without WSL. Ending a program's input,
 * or losing the connection, ends it; the helper goes when no program is left. `prepareSessionHost` comes first.
 */
export function windowsSshRunner(alias: string): CommandRunner {
  const direct = directWindowsRunner(alias);
  const request = (file: string, args: readonly string[], env?: Record<string, string>): SessionRequest =>
    ({ file, args: [...args], ...(env && Object.keys(env).length ? { env } : {}) });
  return {
    ssh: alias, windows: true, direct,
    spawn: (file, args, env): ChildProcessWithoutNullStreams => spawn("ssh", sessionSshArguments(alias, request(file, args, env)), { stdio: "pipe" }),
    run: (file, args, options = {}) => execute("ssh", sessionSshArguments(alias, request(file, args, options.env)), process.env, options),
  };
}

/**
 * Install the helper on the machine, built there with the .NET Framework compiler that ships with Windows, unless this
 * version is installed. Remembers the folder, as a path without spaces, for the machine's later calls.
 */
export async function prepareSessionHost(direct: CommandRunner, signal?: AbortSignal): Promise<void> {
  const { source, start, identity, version } = sessionHostSources();
  const script = `
$root = Join-Path $env:LOCALAPPDATA ${psString(HELPER_ROOT)}
$dir = Join-Path $root ${psString(version)}
function Get-Short([string]$Path) { try { (New-Object -ComObject Scripting.FileSystemObject).GetFolder($Path).ShortPath } catch { $Path } }
if ((Test-Path -LiteralPath (Join-Path $dir ${psString(HOST_EXE)})) -and (Test-Path -LiteralPath (Join-Path $dir ${psString(CLIENT_EXE)})) -and (Test-Path -LiteralPath (Join-Path $dir ${psString(START_SCRIPT)})) -and (Test-Path -LiteralPath (Join-Path $dir ${psString(IDENTITY_SCRIPT)}))) { Get-Short $dir; 'ready'; return }
New-Item -ItemType Directory -Force -Path $root | Out-Null
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$staging = Join-Path $root (${psString(version)} + '.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  $utf8 = New-Object Text.UTF8Encoding $false
  [IO.File]::WriteAllText((Join-Path $staging 'SessionHost.cs'), $payload.source, $utf8)
  [IO.File]::WriteAllText((Join-Path $staging ${psString(START_SCRIPT)}), $payload.start, $utf8)
  # With a byte-order mark, so that Windows PowerShell reads the file as UTF-8.
  [IO.File]::WriteAllText((Join-Path $staging ${psString(IDENTITY_SCRIPT)}), $payload.identity, (New-Object Text.UTF8Encoding $true))
  $csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
  # The compiler's own output is the error report; under Stop its stderr would end the script before it is read.
  $ErrorActionPreference = 'Continue'
  # The host runs without a console window in the user's desktop session; the client is an ordinary console program.
  foreach ($build in @(@('winexe', ${psString(HOST_EXE)}), @('exe', ${psString(CLIENT_EXE)}))) {
    $out = & $csc ${CSC_FLAGS} /target:$($build[0]) /out:"$staging\\$($build[1])" "$staging\\SessionHost.cs" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "The session helper did not compile: $out" }
  }
  $ErrorActionPreference = 'Stop'
  Remove-Item -LiteralPath (Join-Path $staging 'SessionHost.cs') -Force
  try { Rename-Item -LiteralPath $staging -NewName ${psString(version)} } catch { if (-not (Test-Path -LiteralPath (Join-Path $dir ${psString(CLIENT_EXE)}))) { throw } }
} finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force } }
Get-Short $dir
'ready'`;
  const result = await runPowerShell(direct, "powershell.exe", script, { input: JSON.stringify({ source, start, identity }), timeoutMs: 120_000, ...(signal ? { signal } : {}) });
  const lines = result.split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.at(-1) !== "ready" || lines.length < 2) throw new Error(`The session helper installation reported: ${result.slice(0, 300) || "nothing"}`);
  const folder = lines.at(-2)!;
  // The folder sits in the user's profile. A name with spaces that has no short form cannot go through a login shell safely.
  if (!SAFE_TOKEN.test(folder) || !/^[A-Za-z]:\\/.test(folder))
    throw new Error(`The session helper folder ${folder} cannot be named safely in a Windows login shell (a user name with spaces needs 8.3 short names on that drive).`);
  folders.set(direct.ssh!, folder);
}

/** SHA-256 of one file on the machine, computed there. */
export async function remoteWindowsSha256(direct: CommandRunner, file: string, signal?: AbortSignal): Promise<string> {
  const out = await runPowerShell(direct, "powershell.exe", `$s = [IO.File]::OpenRead(${psString(file)}); try { -join ([Security.Cryptography.SHA256]::Create().ComputeHash($s) | ForEach-Object { $_.ToString('x2') }) } finally { $s.Dispose() }`,
    { timeoutMs: 120_000, ...(signal ? { signal } : {}) });
  if (!/^[0-9a-f]{64}$/.test(out)) throw new Error("The machine did not report a file hash.");
  return out;
}

/**
 * Start the helper in the interactive session now, so a missing desktop session or a refused task registration shows
 * as one actionable error before the driver starts. Later connections start it again if it has gone.
 */
export async function ensureSessionHost(alias: string, signal?: AbortSignal): Promise<void> {
  await execute("ssh", [...SSH_OPTIONS, alias, clientCommand(alias, "ensure")], process.env, { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
}
