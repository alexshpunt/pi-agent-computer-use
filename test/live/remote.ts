import { isSemanticAction } from "../../src/semantic-actions.ts";
import { computerSource, displaySource } from "../../src/computer-address.ts";
import type { ComputerAddress } from "../../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../../src/computer-resources.ts";
import { CuaImageSettings } from "../../src/cua-image-settings.ts";
import { machineConfig, machineFactory, sandboxFactory } from "../../src/machine.ts";
import { localRunner, sshRunner, WINDOWS_POWERSHELL, type CommandRunner } from "../../src/runner.ts";
import { readFile } from "node:fs/promises";
import { ComputerSession, type ComputerResult } from "../../src/session.ts";
import { loadComputerConfig } from "../../src/config.ts";
import { McpDriver } from "../../src/driver.ts";
import { MachineHost } from "../../src/machine-host.ts";
import { WebBrowser } from "../../src/web-browser.ts";

/**
 * Connect to the machine named by LIVE_MACHINE (default lab) through the same factory the extension uses,
 * or with LIVE_MACHINE=local to this machine's desktop through the configured local driver.
 * Live checks act on that machine's real desktop: use only new Notepad/Paint documents and synthetic pages.
 * `machine` is where to Insert machine commands such as open; `windows` and `displays` are its discovery addresses.
 */
export async function connectLive(cwd = process.cwd(), mode: "safe" | "yolo" = "yolo") {
  const name = process.env.LIVE_MACHINE ?? "lab";
  const images = new CuaImageSettings(() => "bilinear");
  const config = await loadComputerConfig(cwd);
  let local: ComputerSession | undefined;
  const resources = new ComputerResources(async () => {
    if (name !== "local") throw new Error("Live checks use only the remote machine.");
    return local ??= new ComputerSession(new McpDriver(config), () => mode, () => images.settings(), undefined,
      (options, signal) => WebBrowser.launch({ ...options, interop: config.interop }, signal), new MachineHost(localRunner(config.interop)));
  }, async () => local ? local.close() : { content: [], details: { status: "closed", mode: "yolo" } },
    sandboxFactory({ settings: () => images.settings() }), machineFactory({ getMode: () => mode, settings: () => images.settings() }));
  // A machine starts on its first use; the live checks use the configured one unless LIVE_MACHINE=local.
  const machine = computerSource("machine", name);
  const runner = name === "local" ? localRunner(config.interop) : sshRunner((await machineConfig(cwd, name)).ssh);
  /**
   * One engine command, as the computer_* tools send it: `?hint=` and `?delivery=` on an observation become its ref and
   * delivery_mode (semantic actions never take one), close goes to Delete and kill to Delete with ?force=true, as the tools do.
   */
  const engine = (path: string, command: Record<string, unknown>, signal?: AbortSignal) => {
    const [base, query] = path.split("?");
    if (command.action === "close") return resources.delete(base, cwd, signal);
    if (command.action === "kill") return resources.delete(`${base}?force=true`, cwd, signal);
    const options = new URLSearchParams(query ?? "");
    const address = { ...at(base), ...(options.get("hint") ? { hint: options.get("hint")! } : {}) } as ComputerAddress;
    const delivery = isSemanticAction(String(command.action)) ? null : options.get("delivery");
    return resources.perform(address, cwd, JSON.stringify(delivery ? { ...command, delivery_mode: delivery } : command), signal);
  };
  return {
    resources, machine, cwd, runner,
    /** Where to Search this machine's windows. */
    windows: computerSource("machine", name, "windows"),
    /** Where to Read this machine's displays. */
    displays: computerSource("machine", name, "displays"),
    // Live checks drive the engine under the computer_* tools directly; a sequence view is computer_record's capture.
    read: (path: string, views?: string[]) => (views?.some(view => view.startsWith("sequence")) ? resources.sequence(at(path), cwd, views) : resources.read(at(path), cwd, views)) as Promise<ComputerResult>,
    search: (path: string, query: string) => resources.search(at(path), cwd, query),
    insert: (path: string, command: unknown, signal?: AbortSignal) => engine(path, command as Record<string, unknown>, signal),
    /** Run a Windows PowerShell command on the machine, like a human changing something outside the session. */
    powershell: (command: string) => runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-Command", command]),
    /** Ask one window this check opened to close (WM_CLOSE to that HWND); other windows of its process stay open. */
    closeWindow: (hwnd: number) => runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-Command",
      `Add-Type -Name Close -Namespace PiLive -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; [void][PiLive.Close]::PostMessage([IntPtr]${hwnd}, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)`]).catch(() => ""),
    /** Force-close a process this check opened, for example a modified test document. Only for apps with one process per window. */
    kill: (pid: number) => runner.run(WINDOWS_POWERSHELL, ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]).catch(() => ""),
    write: (path: string, text: string) => engine(path, { action: "type_text", text }),
    close: () => resources.delete("computer:session", cwd).catch(() => undefined),
  };
}

/**
 * PowerShell arguments for a disposable native Win32 target: a WinForms window with a counter button, a list box
 * and a text box behind the standard UIA proxies. Use it where Notepad is missing or would restore the human's tabs.
 */
export function nativeForm(title: string, { dpiAware = false } = {}): string[] {
  // Windows PowerShell is DPI-unaware: above 100% Windows paints its windows at 96 DPI and stretches them.
  // dpiAware switches the process to Per-Monitor V2 first, so the same form paints in physical pixels.
  const aware = dpiAware ? `Add-Type -Name D -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);'
if (-not [W.D]::SetProcessDpiAwarenessContext([IntPtr]-4)) { throw 'DPI awareness was not set' }
` : "";
  const script = `${aware}Add-Type -AssemblyName System.Windows.Forms
$f = New-Object Windows.Forms.Form; $f.Text = '${title}'; $f.Width = 420; $f.Height = 300
$b = New-Object Windows.Forms.Button; $b.Text = 'Count 0'; $b.Left = 10; $b.Top = 10; $b.Width = 120; $script:n = 0
$b.Add_Click({ $script:n++; $b.Text = "Count $script:n" })
$l = New-Object Windows.Forms.ListBox; $l.Left = 10; $l.Top = 50; $l.Height = 80; [void]$l.Items.AddRange(@('alpha', 'beta', 'gamma')); $l.AccessibleName = 'Pick'
$t = New-Object Windows.Forms.TextBox; $t.Left = 10; $t.Top = 150; $t.Width = 300; $t.AccessibleName = 'Field'
$f.Controls.AddRange(@($b, $l, $t)); [void]$f.ShowDialog()`;
  return ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
export const WINDOWS_POWERSHELL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Open an app by path on a machine, sandbox or session address and return its window by title. Edge hands its
 * launch to a broker and a PowerShell launch reports its console rather than the form it shows, so the launch's own
 * window reference is not used.
 */
export async function openWindow(live: Awaited<ReturnType<typeof connectLive>>, source: string, path: string, args: string[], title: string): Promise<string> {
  const launched = await live.insert(source, { action: "open", path, args });
  // A machine lists its windows at its windows address; a sandbox or session at its own.
  const windows = source === live.machine ? live.windows : source;
  for (let i = 0; i < 60; i++) {
    const found = addresses(await live.search(windows, title), "window")[0];
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`No ${title} window appeared: ${text(launched)}`);
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
    .map(ref => kind === "window" ? computerSource(kind, ref) : displaySource(result.details.machine ?? "local", ref));
}
