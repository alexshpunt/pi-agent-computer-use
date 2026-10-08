import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Optional trusted environment overrides. There is no per-window target or agent-supplied executable. */
export interface ComputerConfig { command: string; args?: string[]; interop?: string; runtime?: "windows-held-paths" | "windows-key-holds" | "windows-selected-displays" | "windows-capture-drag" | "windows-shell-desktops" | "windows-single-png" | "windows-semantic-actions" }

/** Find the qualified Windows Driver without changing PATH, services, or machine setup. */
export async function findDriver(version: "0.33.2" = "0.33.2"): Promise<string> {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  const suffix = ["AppData", "Local", "Programs", "PiComputerUsePoC", `cua-driver-${version}`, "cua-driver.exe"];
  const candidates = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA ?? "", "Programs", "PiComputerUsePoC", `cua-driver-${version}`, "cua-driver.exe")]
    : (await readdir("/mnt/c/Users").catch(() => [] as string[])).map(user => path.join("/mnt/c/Users", user, ...suffix));
  const found = [];
  for (const candidate of candidates) if ((await stat(candidate).catch(() => undefined))?.isFile()) found.push(candidate);
  if (found.length !== 1) throw new Error(found.length
    ? "Multiple Windows Driver installs found. Set CUA_DRIVER_PATH to the intended cua-driver.exe."
    : `Windows Cua Driver ${version} was not found. Install the qualified version or set CUA_DRIVER_PATH. Do not install a Linux Driver for the Windows host.`);
  return found[0];
}

/** Read optional local overrides, otherwise discover the installed Driver. Normal opening needs no config file. */
export async function loadComputerConfig(cwd: string, version: "0.33.2" = "0.33.2"): Promise<ComputerConfig> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(path.join(cwd, ".pi", "computer-use.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid .pi/computer-use.json; use the optional environment-only config in docs/standalone-poc.md.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !["command", "args", "interop", "runtime"].includes(key))
    || (raw.command !== undefined && (typeof raw.command !== "string" || !raw.command))
    || (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(arg => typeof arg === "string")))
    || (raw.interop !== undefined && typeof raw.interop !== "string")
    || (raw.runtime !== undefined && (typeof raw.runtime !== "string" || !["windows-held-paths", "windows-key-holds", "windows-selected-displays", "windows-capture-drag", "windows-shell-desktops", "windows-single-png", "windows-semantic-actions"].includes(raw.runtime)))
    || (raw.runtime !== undefined && (typeof raw.command !== "string" || raw.args !== undefined)))
    throw new Error("Invalid computer-use configuration. Remove the old target field: this extension uses YOLO session window references, not configured PID/HWND.");
  return { command: raw.command as string | undefined ?? await findDriver(version),
    ...(raw.args ? { args: raw.args as string[] } : {}), ...(raw.interop ? { interop: raw.interop as string } : {}),
    ...(raw.runtime ? { runtime: raw.runtime as ComputerConfig["runtime"] } : {}) };
}
