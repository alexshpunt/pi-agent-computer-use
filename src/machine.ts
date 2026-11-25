import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { globalComputerConfigFile, loadComputerConfig, readMachineSettings, type ComputerConfig } from "./config.ts";
import { prepareRemoteRuntime } from "./remote-runtime.ts";
import { prepareRemoteBrowser } from "./remote-browser.ts";
import { RemotePreparationUncertain } from "./remote-provision-error.ts";
import { ComputerRequestError, SandboxFullError, machineGuide, type MachineFactory, type SandboxFactory } from "./computer-resources.ts";
import type { CuaVisionSettings } from "./cua-image-settings.ts";
import { McpDriver } from "./driver.ts";
import { MachineHost } from "./machine-host.ts";
import { localRunner, sshRunner, type CommandRunner } from "./runner.ts";
import { WindowsSandbox, connectLoopback, runnerHost, sandboxOptions, waitForGuestDriver } from "./sandbox.ts";
import { IsolatedSession } from "./isolated-session.ts";
import { GuestInputLease, MAX_ZONES, zoneText, type ScreenZone } from "./input-lease.ts";
import { startTileHost } from "./tile-host.ts";
import { ComputerSession, type ComputerMode } from "./session.ts";
import { WebBrowser, WebError } from "./web-browser.ts";
import type { VisualSettings, WindowObserver } from "./native-visuals.ts";
import type { HumanStop } from "./human-stop.ts";

/** The configured machine for a connect command; unknown names refuse before any SSH work. */
export async function machineConfig(cwd: string, name: string): Promise<NonNullable<ComputerConfig["machines"]>[string]> {
  const machine = (await readMachineSettings(cwd)).machines[name];
  if (!machine) throw new ComputerRequestError(`No machine named ${name} is configured in .pi/computer-use.json or ${globalComputerConfigFile()}.`);
  return machine;
}

/** The worker files whose version decides the remote browser's behavior, relative to its package copy. */
const WORKER_FILES: [string, string][] = [
  ["src/web-worker.ts", fileURLToPath(new URL("./web-worker.ts", import.meta.url))],
  ["src/agent-profile-lock.ts", fileURLToPath(new URL("./agent-profile-lock.ts", import.meta.url))],
  ["src/browser-command-line.ts", fileURLToPath(new URL("./browser-command-line.ts", import.meta.url))],
  ["src/aria-match.ts", fileURLToPath(new URL("./aria-match.ts", import.meta.url))],
  ["src/web-geometry.ts", fileURLToPath(new URL("./web-geometry.ts", import.meta.url))],
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
 * Each sandbox or isolated agent session gets its own guest driver and session: no host overlay, no browser launch, every guest window is the agent's own.
 * On another machine the sandbox host and its files are reached over SSH, and the guest relays through SSH tunnels.
 */
export function sandboxFactory(options: { settings: () => CuaVisionSettings; visuals?: VisualSettings }): SandboxFactory {
  return async (cwd, command, signal, machineName) => {
    let parsed;
    try {
      if (command.action === "open_session" && Object.keys(command).some(key => key !== "action")) throw new Error("open_session takes no options.");
      parsed = command.action === "open_session" ? undefined : sandboxOptions(command);
    } catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    const machine = machineName ? await machineConfig(cwd, machineName) : undefined;
    const config = machine ? undefined : await loadComputerConfig(cwd);
    // Zones come from this project's settings and apply when this agent starts the sandbox.
    const zones = !!parsed && (machine ? (await readMachineSettings(cwd)).sandbox : config!.sandbox)?.zones === true;
    const runner = machine ? sshRunner(machine.ssh) : localRunner(config!.interop);
    const commandPath = machine ? machine.command ?? await prepareRemoteRuntime(runner, signal) : config!.command;
    const runtime = machine ? machine.command ? machine.runtime : "windows-desktop" : config!.runtime;
    const sandbox = parsed ? await WindowsSandbox.open(runnerHost(runner), commandPath, { ...parsed, zones }, signal)
      : await IsolatedSession.open(runnerHost(runner), commandPath, signal, { tileHost: startTileHost });
    // The endpoint selects the guest transport; ssh only makes the runtime hash check read the machine's own bytes.
    const override = machine ? machine.driverOverride : config!.driverOverride;
    const driver = new McpDriver({ command: commandPath, ...(runtime ? { runtime } : {}), ...(override ? { driverOverride: true as const } : {}),
      endpoint: sandbox.endpoint, ...(machine ? { ssh: machine.ssh } : {}) }, undefined, options.visuals);
    try { await waitForGuestDriver(driver, signal); }
    catch (error) { await driver.close().catch(() => undefined); await sandbox.close(); throw error; }
    // The stream hub of a session's or this agent's sandbox tiles also gets the agent's window activity, for the agent cursor.
    const activity = sandbox.activity;
    const observer: WindowObserver = activity ? (frame, observed) => { activity(frame); return driver.visuals(frame, observed); } : driver.visuals;
    // Agents share the one Windows Sandbox: each sees only the apps it starts, and input takes turns through the guest's lease.
    const shared = sandbox instanceof WindowsSandbox && sandbox.endpoint ? sandbox.endpoint : undefined;
    const lease = shared ? new GuestInputLease({ connect: signal => connectLoopback(shared.leasePort, signal), token: shared.token, agent: sandbox.ref }) : undefined;
    // With zones on, each agent works in its own zone of the guest screen; with every zone taken, it gets the machine's
    // main desktop. The sandbox decides: the agent that started it chose whether its zones are on.
    let zone: ScreenZone | undefined;
    if (lease) {
      let seat: ScreenZone | "full" | "off";
      try { seat = await joinZones(lease, signal); }
      catch (error) { lease.close(); await driver.close().catch(() => undefined); await sandbox.close(); throw error; }
      if (seat === "full") {
        lease.close(); await driver.close().catch(() => undefined); await sandbox.close();
        throw new SandboxFullError(MAX_ZONES);
      }
      if (seat !== "off") zone = seat;
    }
    const guest = new ComputerSession(driver, () => "yolo", options.settings, observer, undefined, undefined, shared ? { lease, launchedOnly: true, zone } : {});
    // Tiles of this agent's sandbox windows on the desktop of the sandbox's machine; its stream hub runs in this process.
    if (shared) await (sandbox as WindowsSandbox).showTiles(pid => guest.ownsProcess(pid), startTileHost, signal)
      .catch(async error => { lease?.close(); await guest.close().catch(() => undefined); await sandbox.close(); throw error; });
    return { ref: sandbox.ref, session: guest, describe: source => sandbox.describe(source) + (zone ? `\n${zoneText(zone)} This session's windows stay inside it; zones change as agents join and leave.` : ""),
      ...(machineName ? { machine: machineName } : {}),
      close: async () => { try { await guest.close(); } finally { lease?.close(); await sandbox.close(); } } };
  };
}

/**
 * Join the shared sandbox's screen zones. The guest lease service starts last and compiles its code first, so right
 * after the sandbox starts it may not listen yet: connection failures are retried for a while.
 */
async function joinZones(lease: GuestInputLease, signal?: AbortSignal, timeoutMs = 30_000): Promise<ScreenZone | "full" | "off"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await lease.join(signal); }
    catch (error) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) throw new Error(`The shared sandbox's zone service did not answer within ${timeoutMs / 1000} s: ${error instanceof Error ? error.message : error}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Another machine's desktop gets its own driver and session over SSH. Browsers and any desktop activity cues
 * stay on that machine. Safe/YOLO is still the user's choice in Pi.
 */
export function machineFactory(options: { getMode: () => ComputerMode; settings: () => CuaVisionSettings; visuals?: VisualSettings; humanStop?: HumanStop; sessionLabel?: () => string | undefined; escapeStop?: (cwd: string) => Promise<boolean | undefined> }): MachineFactory {
  return async (cwd, name, signal) => {
    const machine = await machineConfig(cwd, name);
    const escapeStop = options.escapeStop ? await options.escapeStop(cwd) : (await readMachineSettings(cwd)).escapeStop;
    const runner = sshRunner(machine.ssh);
    const command = machine.command ?? await prepareRemoteRuntime(runner, signal);
    const runtime = machine.command ? machine.runtime : "windows-desktop";
    const driver = new McpDriver({ command, ...(runtime ? { runtime } : {}), ...(machine.driverOverride ? { driverOverride: true as const } : {}), ...(escapeStop !== undefined ? { escapeStop } : {}), ssh: machine.ssh }, undefined, options.visuals, options.humanStop, options.sessionLabel);
    try { await waitForGuestDriver(driver, signal, 30_000); }
    catch (error) { await driver.close().catch(() => undefined); throw error; }
    const launchWeb = async (launch: Parameters<typeof WebBrowser.launch>[0], webSignal?: AbortSignal) => {
      const prepared = await prepareRemoteBrowser(runner, webSignal, { node: machine.node, package: machine.package }).catch(error => {
        if (error instanceof RemotePreparationUncertain) throw new WebError(error.message, false, true);
        throw error;
      });
      const node = prepared.node;
      const workerPackage = prepared.package;
      if (machine.package) await checkRemoteWorker(runner, workerPackage, "the explicit browser worker override", webSignal);
      return WebBrowser.launch({ ...launch, remote: { runner, node, worker: `${workerPackage}/src/web-worker.ts` } }, webSignal);
    };
    const remote = new ComputerSession(driver, options.getMode, options.settings, undefined, launchWeb, new MachineHost(runner));
    return { ref: name, session: remote,
      describe: source => [`# Machine ${name}`, `Address: ${source}`, `SSH: ${machine.ssh}`,
        "Browser: prepared automatically on first use", ...machineGuide(source)].join("\n"),
      close: () => remote.close() };
  };
}
