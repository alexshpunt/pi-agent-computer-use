// Helpers for the demo runner: commands on the painting machine's Windows, reached over SSH into its WSL.
import { spawn } from "node:child_process";
import { powershellOf, runPowerShell, sshRunner, SSH_OPTIONS, type CommandRunner } from "../../src/runner.ts";

export interface Remote {
  alias: string;
  runner: CommandRunner;
  /** Run a Bash script in the machine's WSL and return its stdout. */
  bash(script: string, timeoutMs?: number): Promise<string>;
  /** Run a PowerShell script on the machine's Windows and return its trimmed stdout. */
  powershell(script: string, timeoutMs?: number): Promise<string>;
  /** Copy a file from the machine's WSL to this machine. */
  pull(remotePath: string, localPath: string): Promise<void>;
  /** Copy a file from this machine to the machine's WSL. */
  push(localPath: string, remotePath: string): Promise<void>;
}

export function remote(alias: string): Remote {
  const runner = sshRunner(alias);
  const scp = (from: string, to: string) => new Promise<void>((resolve, reject) => {
    const child = spawn("scp", ["-q", ...SSH_OPTIONS.filter(option => option !== "-T"), from, to], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`scp ${from} ${to} failed: ${error.trim()}`)));
  });
  return {
    alias,
    runner,
    bash: (script, timeoutMs = 60_000) => runner.run("bash", ["-c", script], { timeoutMs }),
    powershell: (script, timeoutMs = 60_000) => runPowerShell(runner, powershellOf(runner), script, { timeoutMs, scriptOnStdin: true }),
    pull: (remotePath, localPath) => scp(`${alias}:${remotePath}`, localPath),
    push: (localPath, remotePath) => scp(localPath, `${alias}:${remotePath}`),
  };
}

/** Quote a value for a PowerShell single-quoted string. */
export const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
/** Quote a value for Bash. */
export const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Find the newest ffmpeg.exe on the machine: on PATH or installed by winget (Gyan.FFmpeg). Returns its Windows path. */
export async function findFfmpeg(machine: Remote): Promise<string> {
  const found = await machine.powershell(String.raw`
$command = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($command) { $command.Source; return }
$candidate = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin\ffmpeg.exe" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($candidate) { $candidate.FullName }`);
  if (!found) throw new Error(`ffmpeg is missing on ${machine.alias}. Install it there with: winget install Gyan.FFmpeg`);
  return found;
}

/** A Windows path as the machine's WSL sees it. */
export async function wslPath(machine: Remote, windowsPath: string): Promise<string> {
  return (await machine.bash(`wslpath -u ${shQuote(windowsPath)}`)).trim();
}
