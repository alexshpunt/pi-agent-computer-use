import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Where native helpers run: this WSL (with Windows reached through interop) or another WSL reached over SSH.
 * Paths are in the runner's own WSL; Windows programs are started by their /mnt/c path.
 */
export interface CommandRunner {
  /** SSH alias for a remote machine; undefined locally. */
  readonly ssh?: string;
  /** Start a long-lived process with piped stdio. Ending its stdin is the shutdown signal. */
  spawn(file: string, args: readonly string[], env?: Record<string, string>): ChildProcessWithoutNullStreams;
  /** Run a short command, optionally with stdin, and return its stdout. */
  run(file: string, args: readonly string[], options?: { input?: string | Buffer; signal?: AbortSignal; timeoutMs?: number; env?: Record<string, string> }): Promise<string>;
}

/** Windows PowerShell as seen from WSL. */
export const WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/** Run helpers on this machine. Windows programs need the WSL interop socket. */
export function localRunner(interop?: string): CommandRunner {
  const environment = (env?: Record<string, string>) => ({ ...process.env, ...(interop ? { WSL_INTEROP: interop } : {}), ...env });
  return {
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
    const child = execFile(file, args, { env, signal: options.signal, timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${file === "ssh" ? "Remote command" : file} failed: ${(stderr.toString() || error.message).trim().slice(0, 500)}`));
        else resolve(stdout.toString());
      });
    child.stdin?.end(options.input);
  });
}
