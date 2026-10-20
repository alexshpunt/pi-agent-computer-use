import { computerSource } from "../../src/computer-address.ts";
import type { ComputerAddress } from "../../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../../src/computer-resources.ts";
import { CuaImageSettings } from "../../src/cua-image-settings.ts";
import { machineConfig, machineFactory } from "../../src/machine.ts";
import { localRunner, sshRunner, WINDOWS_POWERSHELL, type CommandRunner } from "../../src/runner.ts";
import { readFile } from "node:fs/promises";
import { ComputerSession, type ComputerResult } from "../../src/session.ts";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { MachineHost } from "../../src/machine-host.ts";
import { WebBrowser } from "../../src/web-browser.ts";

/**
 * Connect to the machine named by LIVE_MACHINE (default zinpc) through the same factory the extension uses,
 * or with LIVE_MACHINE=local to this machine's desktop through the configured local driver.
 * Live checks act on that machine's real desktop: use only new Notepad/Paint documents and synthetic pages.
 * `machine` is where to Insert open and Search windows: the machine address, or computer:session locally.
 */
export async function connectLive(cwd = process.cwd()) {
  const name = process.env.LIVE_MACHINE ?? "zinpc";
  const images = new CuaImageSettings(() => "bilinear");
  const config = await loadComputerConfig(cwd);
  let local: ComputerSession | undefined;
  const resources = new ComputerResources(async () => {
    if (name !== "local") throw new Error("Live checks use only the remote machine.");
    return local ??= new ComputerSession(new McpDriver(config), () => "yolo", () => images.settings(), undefined, undefined,
      (options, signal) => WebBrowser.launch({ ...options, interop: config.interop }, signal), new MachineHost(localRunner(config.interop)));
  }, async () => local ? local.close() : { content: [], details: { status: "closed", mode: "yolo" } }, undefined,
    machineFactory({ getMode: () => "yolo", settings: () => images.settings() }));
  const machine = name === "local" ? "computer:session"
    : computerSource("machine", (await resources.perform(at("computer:session"), cwd, JSON.stringify({ action: "connect", machine: name }), "insert")).details.machine_ref!);
  const runner = name === "local" ? localRunner(config.interop) : sshRunner((await machineConfig(cwd, name)).ssh);
  return {
    resources, machine, cwd, runner,
    /** Where to Search this desktop's windows. */
    windows: name === "local" ? "computer:windows" : machine,
    read: (path: string, views?: string[]) => resources.read(at(path), cwd, views) as Promise<ComputerResult>,
    search: (path: string, query: string) => resources.search(at(path), cwd, query),
    insert: (path: string, command: unknown, signal?: AbortSignal) => resources.perform(at(path), cwd, JSON.stringify(command), "insert", signal),
    /** Run a Windows PowerShell command on the machine, like a human changing something outside the session. */
    powershell: (command: string) => runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-Command", command]),
    /** Ask one window this check opened to close (WM_CLOSE to that HWND); other windows of its process stay open. */
    closeWindow: (hwnd: number) => runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-Command",
      `Add-Type -Name Close -Namespace PiLive -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; [void][PiLive.Close]::PostMessage([IntPtr]${hwnd}, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)`]).catch(() => ""),
    /** Force-close a process this check opened, for example a modified test document. Only for apps with one process per window. */
    kill: (pid: number) => runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]).catch(() => ""),
    write: (path: string, text: string) => resources.perform(at(path), cwd, text, "write"),
    close: () => resources.perform(at("computer:session"), cwd, JSON.stringify({ action: "close" }), "insert").catch(() => undefined),
  };
}

/** Serve scripts/web-fixture.mjs on the machine (its WSL loopback, reachable by its Windows browsers) and read its journal. */
export async function serveFixture(runner: CommandRunner) {
  await runner.run("dd", ["status=none", "of=/tmp/pi-web-fixture.mjs"], { input: await readFile("scripts/web-fixture.mjs") });
  const child = runner.spawn("node", ["/tmp/pi-web-fixture.mjs"]);
  const base = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => { const match = /FIXTURE (\S+)/.exec(chunk.toString()); if (match) resolve(match[1].replace(/\/$/, "")); });
    child.on("exit", () => reject(new Error("The web fixture exited.")));
  });
  return {
    base,
    journal: async () => JSON.parse(await runner.run("curl", ["-s", `${base}/journal`])) as { type: string; [key: string]: unknown }[],
    close: () => { child.stdin.end(); child.kill(); },
  };
}

/**
 * Select a Paint tool (Pencil, Text, …) by its button. A narrow window (for example on a Remote Desktop display)
 * collapses the ribbon into group buttons; then the Tools group is opened first and the tool picked from its flyout.
 */
export async function paintTool(live: Awaited<ReturnType<typeof connectLive>>, window: string, name: string): Promise<void> {
  type Element = { hint: string; role: string; name: string | null };
  const click = async (view: ComputerResult, element: Element) => {
    const result = await live.insert(`computer:observation/${view.details.observation_id}?hint=${encodeURIComponent(element.hint)}&delivery=foreground`, { action: "click" });
    if (result.details.status !== "delivered") throw new Error(`Clicking ${element.name} was not delivered: ${text(result)}`);
  };
  let view = await live.read(window, ["full"]);
  let tool = (view.details.ui!.elements as Element[]).find(e => e.role === "Button" && e.name === name);
  if (!tool) {
    const group = (view.details.ui!.elements as Element[]).find(e => e.role === "Button" && e.name === "Tools");
    if (!group) throw new Error(`Paint shows neither a ${name} button nor a Tools group.`);
    await click(view, group);
    for (let attempt = 0; attempt < 3 && !tool; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 600));
      view = await live.read(window, ["full"]);
      tool = (view.details.ui!.elements as Element[]).find(e => e.role === "Button" && e.name === name);
    }
    if (!tool) throw new Error(`The Tools flyout has no ${name} button.`);
  }
  await click(view, tool);
}
export const at = (path: string): ComputerAddress => requireComputerAddress(path);
export const text = (result: ComputerResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
/** Window or display addresses listed by a discovery result. */
export function addresses(result: ComputerResult, kind: "window" | "display"): string[] {
  const rows = (result.details.state?.[kind === "window" ? "windows" : "displays"] ?? []) as Record<string, unknown>[];
  return rows.map(row => row[kind === "window" ? "window_ref" : "display_ref"]).filter((ref): ref is string => typeof ref === "string")
    .map(ref => computerSource(kind, ref));
}
