import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const isSocket = async (file: string) => (await stat(file).catch(() => undefined))?.isSocket() ?? false;

/**
 * The WSL interop socket to start Windows programs through. WSL_INTEROP names the socket of the WSL session a process
 * started in; a process started from a long-lived terminal keeps it after that session closes, and every Windows
 * command then fails. A live WSL_INTEROP is kept; otherwise the lowest-numbered live socket in `dir` is used: `1_interop`
 * belongs to WSL's init and lives as long as the distribution. Undefined when none is live (not WSL, or WSL is down).
 */
export async function liveInterop(env = process.env.WSL_INTEROP, dir = "/run/WSL"): Promise<string | undefined> {
  if (env && await isSocket(env)) return env;
  const names = (await readdir(dir).catch(() => [] as string[])).filter(name => /^\d+_interop$/.test(name))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  for (const name of names) {
    const file = path.join(dir, name);
    if (await isSocket(file)) return file;
  }
  return undefined;
}
