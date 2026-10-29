import { access } from "node:fs/promises";
import path from "node:path";
import { windowsLocalAppData } from "./native-runtime.ts";
import { WINDOWS_NODE } from "./setup-pins.ts";

const INSTALLED_NODE = "/mnt/c/Program Files/nodejs/node.exe";

export class WindowsNodeMissingError extends Error {
  constructor() { super("Browsers need Node.js on Windows, and none is installed here. Ask the user to install it with /computer-setup browser (about 30 MB into their own folders), then open the browser again."); }
}

/** Where setup part browser puts the pinned portable Node under a Local Application Data folder (WSL path). */
export function portableNodePath(localAppData: string): string {
  return path.join(localAppData, "Programs", "PiComputerUse", `node-${WINDOWS_NODE.version}-win-x64`, "node.exe");
}

const exists = (file: string) => access(file).then(() => true, () => false);

/**
 * The Windows node.exe that runs the Playwright worker from WSL: the portable one from setup, else an installed Node.
 * Without either, refuse with the setup step instead of failing on a missing executable.
 */
export async function findWindowsNode(interop?: string, deps = { localAppData: windowsLocalAppData, exists }): Promise<string> {
  const candidates = [portableNodePath(await deps.localAppData(interop)), INSTALLED_NODE];
  for (const candidate of candidates) if (await deps.exists(candidate)) return candidate;
  throw new WindowsNodeMissingError();
}

/** Find a compatible Windows Node or prepare the package-managed executable on first browser use. */
export async function ensureWindowsNode(interop?: string, signal?: AbortSignal): Promise<string> {
  const [{ prepareWindowsNode }, { localRunner }] = await Promise.all([import("./remote-browser.ts"), import("./runner.ts")]);
  return prepareWindowsNode(localRunner(interop), signal);
}