import { loadComputerConfig, type ComputerConfig } from "./config.ts";
import { ComputerRequestError, type MachineFactory } from "./computer-resources.ts";
import type { CuaVisionSettings } from "./cua-image-settings.ts";
import { displayModes } from "./display-mode.ts";
import { McpDriver } from "./driver.ts";
import { sshRunner } from "./runner.ts";
import { waitForGuestDriver } from "./sandbox.ts";
import { ComputerSession, type ComputerMode, type Content } from "./session.ts";
import { WebBrowser } from "./web-browser.ts";

/** The configured machine for a connect command; unknown names refuse before any SSH work. */
export async function machineConfig(cwd: string, name: string): Promise<NonNullable<ComputerConfig["machines"]>[string]> {
  const machine = (await loadComputerConfig(cwd)).machines?.[name];
  if (!machine) throw new ComputerRequestError(`No machine named ${name} is configured in .pi/computer-use.json.`);
  return machine;
}

/**
 * Another machine's desktop gets its own driver and session over SSH. Safe/YOLO is the user's choice there too;
 * the host overlay is not shown, and browsers start on that machine.
 */
export function machineFactory(options: { getMode: () => ComputerMode; settings: () => CuaVisionSettings; retainRaw?: (image: Content) => void }): MachineFactory {
  return async (cwd, name, signal) => {
    const machine = await machineConfig(cwd, name);
    const runner = sshRunner(machine.ssh);
    const driver = new McpDriver({ command: machine.command, ...(machine.runtime ? { runtime: machine.runtime } : {}), ssh: machine.ssh });
    try { await waitForGuestDriver(driver, signal, 30_000); }
    catch (error) { await driver.close().catch(() => undefined); throw error; }
    const launchWeb = machine.node && machine.package
      ? (launch: Parameters<typeof WebBrowser.launch>[0], webSignal?: AbortSignal) =>
        WebBrowser.launch({ ...launch, remote: { runner, node: machine.node!, worker: `${machine.package}/src/web-worker.ts` } }, webSignal)
      : undefined;
    const remote = new ComputerSession(driver, options.getMode, options.settings, undefined, options.retainRaw, launchWeb, displayModes(runner));
    return { ref: name, session: remote,
      describe: source => [`# Remote machine ${name}`, `Address: ${source}`, `SSH: ${machine.ssh}`,
        `Browser: ${launchWeb ? "available" : "not configured (node and package)"}`,
        "Search this address for that machine's windows; Read it for its displays, and Insert resize into a display address to change its resolution. Insert open, open_browser, open_sandbox or disconnect."].join("\n"),
      close: () => remote.close().then(() => undefined) };
  };
}
