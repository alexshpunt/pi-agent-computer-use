import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadComputerConfig, type ComputerConfig } from "./config.ts";
import { ComputerRequestError, type MachineFactory } from "./computer-resources.ts";
import type { CuaVisionSettings } from "./cua-image-settings.ts";
import { McpDriver } from "./driver.ts";
import { MachineHost } from "./machine-host.ts";
import { sshRunner, type CommandRunner } from "./runner.ts";
import { waitForGuestDriver } from "./sandbox.ts";
import { ComputerSession, type ComputerMode, type Content } from "./session.ts";
import { WebBrowser } from "./web-browser.ts";

/** The configured machine for a connect command; unknown names refuse before any SSH work. */
export async function machineConfig(cwd: string, name: string): Promise<NonNullable<ComputerConfig["machines"]>[string]> {
  const machine = (await loadComputerConfig(cwd)).machines?.[name];
  if (!machine) throw new ComputerRequestError(`No machine named ${name} is configured in .pi/computer-use.json.`);
  return machine;
}

/** What the remote browser worker runs, relative to its package copy; its other imports are type-only. */
const WORKER_FILES: [string, string][] = [
  ["src/web-worker.ts", fileURLToPath(new URL("./web-worker.ts", import.meta.url))],
  ["node_modules/playwright-core/package.json", createRequire(import.meta.url).resolve("playwright-core/package.json")],
];

/**
 * Refuse a remote browser before launch when that machine's worker copy differs from this package, so an old
 * worker never silently ignores newer options. `refresh` is the setup command that updates the copy.
 */
export async function checkRemoteWorker(runner: CommandRunner, remotePackage: string, refresh: string, signal?: AbortSignal): Promise<void> {
  const local = await Promise.all(WORKER_FILES.map(async ([, file]) => createHash("sha256").update(await readFile(file)).digest("hex")));
  // A missing file fails sha256sum: then every file counts as stale.
  const output = await runner.run("sha256sum", WORKER_FILES.map(([name]) => `${remotePackage}/${name}`), { signal, timeoutMs: 10_000 })
    .catch(() => "");
  const remote = output.split("\n").map(line => line.split(" ")[0]);
  const stale = WORKER_FILES.filter((_, index) => remote[index] !== local[index]).map(([name]) => name);
  if (stale.length) throw new ComputerRequestError(`The browser worker on this machine is missing or out of date (${stale.join(", ")}); nothing was launched. `
    + `Refresh it from this package with ${refresh}, then open the browser again.`);
}

/**
 * Another machine's desktop gets its own driver and session over SSH. Safe/YOLO is the user's choice there too;
 * the host overlay is not shown, and browsers start on that machine.
 */
export function machineFactory(options: { getMode: () => ComputerMode; settings: () => CuaVisionSettings; retainRaw?: (image: Content) => void }): MachineFactory {
  return async (cwd, name, signal) => {
    const machine = await machineConfig(cwd, name);
    const local = (await loadComputerConfig(cwd)).command;
    const runtimeFolder = local?.endsWith("/runtime/cua-driver.exe") ? path.dirname(path.dirname(local)) : "<local runtime folder>";
    const refresh = `scripts/setup-remote-machine.sh ${machine.ssh} ${runtimeFolder} ${name}`;
    const runner = sshRunner(machine.ssh);
    const driver = new McpDriver({ command: machine.command, ...(machine.runtime ? { runtime: machine.runtime } : {}), ssh: machine.ssh });
    try { await waitForGuestDriver(driver, signal, 30_000); }
    catch (error) { await driver.close().catch(() => undefined); throw error; }
    const launchWeb = machine.node && machine.package
      ? async (launch: Parameters<typeof WebBrowser.launch>[0], webSignal?: AbortSignal) => {
        await checkRemoteWorker(runner, machine.package!, refresh, webSignal);
        return WebBrowser.launch({ ...launch, remote: { runner, node: machine.node!, worker: `${machine.package}/src/web-worker.ts` } }, webSignal);
      }
      : undefined;
    const remote = new ComputerSession(driver, options.getMode, options.settings, undefined, options.retainRaw, launchWeb, new MachineHost(runner));
    return { ref: name, session: remote,
      describe: source => [`# Remote machine ${name}`, `Address: ${source}`, `SSH: ${machine.ssh}`,
        `Browser: ${launchWeb ? "available" : "not configured (node and package)"}`,
        "Search this address for that machine's windows; Read it for its displays, and Insert resize into a display address to change its resolution. Insert open, open_browser, open_sandbox or disconnect."].join("\n"),
      close: () => remote.close().then(() => undefined) };
  };
}
