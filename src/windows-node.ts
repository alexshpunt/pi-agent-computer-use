import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { windowsLocalAppData } from "./native-runtime.ts";

const PIN = new URL("../scripts/windows-node.json", import.meta.url);
const INSTALLED_NODE = "/mnt/c/Program Files/nodejs/node.exe";

/** Where `/computer-setup browser` puts the pinned portable Node under a Local Application Data folder (WSL path). */
export async function portableNodePath(localAppData: string): Promise<string> {
  const { version } = JSON.parse(await readFile(PIN, "utf8")) as { version: string };
  return path.join(localAppData, "Programs", "PiComputerUse", `node-${version}-win-x64`, "node.exe");
}

const exists = (file: string) => access(file).then(() => true, () => false);

/**
 * The Windows node.exe that runs the Playwright worker from WSL: the portable one from setup, else an installed Node.
 * Without either, refuse with the setup step instead of failing on a missing executable.
 */
export async function findWindowsNode(interop?: string, deps = { localAppData: windowsLocalAppData, exists }): Promise<string> {
  const candidates = [await portableNodePath(await deps.localAppData(interop)), INSTALLED_NODE];
  for (const candidate of candidates) if (await deps.exists(candidate)) return candidate;
  throw new Error("Browsers need Node.js on Windows, and none is installed here. Ask the user before installing it; "
    + "with their permission run /computer-setup browser (about 30 MB into their own folders), then open the browser again.");
}
