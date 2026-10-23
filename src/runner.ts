import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where native helpers run: Windows itself when Pi runs there, this WSL (Windows reached through interop) or another
 * WSL reached over SSH. In WSL, paths are the runner's own WSL paths and Windows programs start by their /mnt/c path.
 */
export interface CommandRunner {
  /** SSH alias for a remote machine; undefined locally. */
  readonly ssh?: string;
  /** Pi itself runs on this Windows: no WSL, paths are Windows paths and programs start by their Windows names. */
  readonly windows?: boolean;
  /** Start a long-lived process with piped stdio. Ending its stdin is the shutdown signal. */
  spawn(file: string, args: readonly string[], env?: Record<string, string>): ChildProcessWithoutNullStreams;
  /** Run a short command, optionally with stdin, and return its stdout. */
  run(file: string, args: readonly string[], options?: { input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string> }): Promise<string>;
}

/** Windows PowerShell as seen from WSL. */
export const WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/** Windows PowerShell as the runner starts it. */
export const powershellOf = (runner: CommandRunner): string => runner.windows ? "powershell.exe" : WINDOWS_POWERSHELL;

/**
 * Files on the runner's machine, addressed by the runner's own paths (Windows paths when Pi runs on Windows).
 * Directly through Node there; through small WSL commands locally from WSL or over SSH.
 */
export interface RunnerFiles {
  /** A Windows path as this runner addresses it. */
  native(windows: string): Promise<string>;
  /** A runner path as Windows sees it. */
  windows(native: string): Promise<string>;
  join(...parts: string[]): string;
  mkdir(dir: string): Promise<void>;
  write(file: string, bytes: string | Buffer): Promise<void>;
  read(file: string): Promise<Buffer>;
  rename(from: string, to: string): Promise<void>;
  list(dir: string): Promise<{ name: string; bytes: number }[]>;
  remove(target: string): Promise<void>;
}

export function runnerFiles(runner: CommandRunner): RunnerFiles {
  if (runner.windows) return {
    native: async value => value,
    windows: async value => value,
    join: (...parts) => path.win32.join(...parts),
    mkdir: async dir => { await mkdir(dir, { recursive: true }); },
    write: (file, bytes) => writeFile(file, bytes),
    read: file => readFile(file),
    rename: (from, to) => rename(from, to),
    list: async dir => Promise.all((await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile())
      .map(async entry => ({ name: entry.name, bytes: (await stat(path.win32.join(dir, entry.name))).size }))),
    remove: target => rm(target, { recursive: true, force: true }),
  };
  return {
    native: async value => (await runner.run("wslpath", ["-u", value])).trim(),
    windows: async value => (await runner.run("wslpath", ["-w", value])).trim(),
    join: (...parts) => path.posix.join(...parts),
    mkdir: async dir => { await runner.run("mkdir", ["-p", "--", dir]); },
    write: async (file, bytes) => { await runner.run("dd", ["status=none", `of=${file}`], { input: bytes, timeoutMs: 600_000 }); },
    read: async file => Buffer.from((await runner.run("base64", ["-w0", "--", file], { timeoutMs: 120_000 })).trim(), "base64"),
    rename: async (from, to) => { await runner.run("mv", ["-f", "--", from, to]); },
    list: async dir => (await runner.run("find", [dir, "-maxdepth", "1", "-type", "f", "-printf", "%f\\t%s\\n"]))
      .split("\n").filter(Boolean).map(line => { const [name, bytes] = line.split("\t"); return { name, bytes: Number(bytes) }; }),
    remove: async target => { await runner.run("rm", ["-rf", "--", target]); },
  };
}

/**
 * Run a PowerShell script on the runner's Windows with UTF-8 output and stop-on-error; a thrown error exits 1 with
 * its message on stderr. `powershell` is the executable as the runner sees it: WINDOWS_POWERSHELL from WSL,
 * "powershell.exe" when Pi itself runs on Windows.
 */
export function runPowerShell(runner: CommandRunner, powershell: string, script: string,
  options: { input?: string | Buffer; timeoutMs?: number; signal?: AbortSignal; scriptOnStdin?: boolean } = {}): Promise<string> {
  // UTF-8 output: the console code page would turn characters such as • into control bytes.
  const wrapped = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8\ntry {\n${script}\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  const run = (args: string[], input?: string | Buffer) => runner.run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args],
    { ...(input !== undefined ? { input } : {}), timeoutMs: options.timeoutMs ?? 60_000, ...(options.signal ? { signal: options.signal } : {}) })
    .then(output => output.replace(/\r/g, "").trim());
  // Some long -EncodedCommand values fail to start through WSL interop ("Invalid argument"); a long script can
  // instead arrive on stdin as base64 of UTF-8, behind a short fixed command line.
  if (options.scriptOnStdin) return run(["-Command",
    "& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))))"],
  Buffer.from(wrapped, "utf8").toString("base64"));
  return run(["-EncodedCommand", Buffer.from(wrapped, "utf16le").toString("base64")], options.input);
}

/** Run helpers on this machine. Windows programs need the WSL interop socket. */
export function localRunner(interop?: string): CommandRunner {
  const environment = (env?: Record<string, string>) => ({ ...process.env, ...(interop ? { WSL_INTEROP: interop } : {}), ...env });
  return {
    ...(process.platform === "win32" ? { windows: true } : {}),
    spawn: (file, args, env) => spawn(file, [...args], { stdio: "pipe", windowsHide: true, env: environment(env) }),
    run: (file, args, options = {}) => execute(file, [...args], environment(options.env), options),
  };
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/**
 * The remote command line: the remote login shell may be fish, so the real Bash command travels as base64,
 * which no shell needs to quote, and stdin stays free for the helper.
 */
export function remoteCommand(file: string, args: readonly string[], env: Record<string, string> = {}): string {
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name ${key}.`);
    return `${key}=${quote(value)}`;
  });
  const script = `exec env ${assignments.join(" ")} ${[file, ...args].map(quote).join(" ")}`;
  return `bash -c 'eval "$(printf %s ${Buffer.from(script).toString("base64")} | base64 -d)"'`;
}

/** OpenSSH options: keys and host trust stay in the user's SSH config; never prompt. */
export const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

/** Run helpers on another machine's WSL over SSH. When SSH ends, helpers see EOF on stdin and exit. */
export function sshRunner(alias: string): CommandRunner {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(alias)) throw new Error("Invalid SSH alias.");
  const args = (file: string, rest: readonly string[], env?: Record<string, string>) => [...SSH_OPTIONS, alias, remoteCommand(file, rest, env)];
  return {
    ssh: alias,
    spawn: (file, rest, env) => spawn("ssh", args(file, rest, env), { stdio: "pipe" }),
    run: (file, rest, options = {}) => execute("ssh", args(file, rest, options.env), process.env, options),
  };
}

function execute(file: string, args: string[], env: NodeJS.ProcessEnv, options: { input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, signal: options.signal, timeout: options.timeoutMs ?? 60_000, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${file === "ssh" ? "Remote command" : file} failed: ${(stderr.toString() || error.message).trim().slice(0, 500)}`));
        else resolve(stdout.toString());
      });
    child.stdin?.end(options.input);
  });
}
