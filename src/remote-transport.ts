import { directWindowsRunner } from "./windows-ssh.ts";
import { runPowerShell, sshRunner } from "./runner.ts";

/** How another machine's Windows is reached over its SSH alias: through the WSL the login lands in, or natively. */
export type RemoteTransport = "wsl" | "windows";

const detected = new Map<string, Promise<RemoteTransport>>();

/**
 * The transport of a machine: the trusted configuration when it names one, otherwise what the SSH login is. A login
 * that runs bash is the WSL transport, as before. A login that does not is a Windows machine without WSL when
 * Windows PowerShell answers. The answer is kept for this Pi process.
 */
export function remoteTransport(alias: string, configured?: RemoteTransport, signal?: AbortSignal): Promise<RemoteTransport> {
  if (configured) return Promise.resolve(configured);
  let pending = detected.get(alias);
  if (!pending) {
    pending = probe(alias, signal);
    detected.set(alias, pending);
    pending.catch(() => { if (detected.get(alias) === pending) detected.delete(alias); });
  }
  return pending;
}

async function probe(alias: string, signal?: AbortSignal): Promise<RemoteTransport> {
  signal?.throwIfAborted();
  const wsl = await sshRunner(alias).run("bash", ["-c", "printf pi-wsl"], { signal, timeoutMs: 20_000 }).then(out => ({ ok: out.trim() === "pi-wsl" as string }), (error: unknown) => ({ ok: false, error }));
  if (wsl.ok) return "wsl";
  signal?.throwIfAborted();
  try {
    if (await runPowerShell(directWindowsRunner(alias), "powershell.exe", "'pi-windows'", { signal, timeoutMs: 30_000 }) === "pi-windows") return "windows";
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`The SSH alias ${alias} runs neither bash (a WSL login) nor Windows PowerShell (a Windows login without WSL): ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`The SSH alias ${alias} runs neither bash (a WSL login) nor Windows PowerShell (a Windows login without WSL).`);
}
