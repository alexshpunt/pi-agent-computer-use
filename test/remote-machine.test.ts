import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { computerSource, displaySource } from "../src/computer-address.ts";
import { ComputerRequestError, ComputerResources, requireComputerAddress, type OpenedMachine, type OpenedSandbox } from "../src/computer-resources.ts";
import { loadComputerConfig } from "../src/config.ts";
import { checkRemoteWorker } from "../src/machine.ts";
import { presentComputerResult } from "../src/provider.ts";
import { remoteCommand, type CommandRunner } from "../src/runner.ts";
import { ComputerSession, type Driver } from "../src/session.ts";

const cwd = "/synthetic-remote-fixture";
const address = requireComputerAddress;

test("a remote command keeps every argument and variable exactly, whatever the remote login shell", () => {
  const args = ["it's", "a \"b\" $HOME `x` $(id)", "ü ✓", ""];
  const command = remoteCommand("/usr/bin/printf", ["%s|", ...args], { NAME: "a b'c" });
  // SSH hands the command to the login shell as one string; bash and fish both run it.
  expect(execFileSync("bash", ["-c", command]).toString()).toBe(args.map(arg => `${arg}|`).join(""));
  expect(execFileSync("bash", ["-c", remoteCommand("/usr/bin/env", [], { NAME: "a b'c" })]).toString()).toContain("NAME=a b'c\n");
  expect(() => remoteCommand("/usr/bin/env", [], { "BAD-NAME": "x" })).toThrow(/Invalid environment variable/);
});

test("machines come only from validated configuration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-machines-"));
  await mkdir(path.join(dir, ".pi"));
  const write = (machines: unknown) => writeFile(path.join(dir, ".pi/computer-use.json"), JSON.stringify({ command: "/x/cua-driver.exe", machines }));
  await write({ lab: { ssh: "lab-wsl", command: "/mnt/c/run/cua-driver.exe", runtime: "windows-desktop", node: "/mnt/c/node.exe", package: "/home/u/pkg" } });
  expect((await loadComputerConfig(dir)).machines?.lab).toEqual({ ssh: "lab-wsl", command: "/mnt/c/run/cua-driver.exe", runtime: "windows-desktop", node: "/mnt/c/node.exe", package: "/home/u/pkg" });
  for (const bad of [{ "Bad Name": { ssh: "a", command: "/x" } }, { local: { ssh: "a", command: "/x" } }, { pc: { ssh: "a", command: "relative/cua.exe" } }, { pc: { ssh: "a", command: "/x", extra: 1 } }, { pc: { ssh: "a", command: "/x", runtime: "unknown" } }, []]) {
    await write(bad);
    await expect(loadComputerConfig(dir)).rejects.toThrow(/Invalid machines/);
  }
});

const png = (await sharp({ create: { width: 40, height: 30, channels: 3, background: "red" } }).png().toBuffer()).toString("base64");
const image = { type: "image" as const, mimeType: "image/png", data: png };
/** One display's pixels as the native runtime reports them: 1920x1080 scaled to 40x30 here. */
const pixels = { platform: "windows", screenshot_width: 40, screenshot_height: 30, screenshot_original_width: 1920, screenshot_original_height: 1080 };

/** A fake native backend with one window and one display. */
function backend(pid: number) {
  const display = { display_id: `D${pid}`, primary: true, monitor_handle: `0x${pid}`, monitor_device_paths: [`\\\\?\\DISPLAY#${pid}`],
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }, work_area: { x: 0, y: 0, width: 1920, height: 1040 }, scale_factor: 1, dpi: 96 };
  const driver: Driver = {
    identity: vi.fn(async () => `life-${pid}`), close: vi.fn(async () => {}), selectedDisplays: true,
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid, window_id: 7, title: `window ${pid}` }] } };
      if (name === "list_displays") return { content: [], structuredContent: { platform: "windows", topology_id: `t${pid}`, displays: [display] } };
      if (name === "get_desktop_state") return { content: [image], structuredContent: { ...pixels, display: "primary" } };
      if (name === "get_display_state") return { content: [image], structuredContent: { ...pixels, display, topology_id: `t${pid}` } };
      // A sequence frame: pixels without the UI tree.
      if (name === "get_window_state" && (args as { include_accessibility_tree?: boolean }).include_accessibility_tree === false)
        return { content: [image], structuredContent: { pid, window_id: 7, window_bounds: { x: 0, y: 0, width: 40, height: 30 },
          screenshot_width: 40, screenshot_height: 30, screenshot_original_width: 40, screenshot_original_height: 30 } };
      // No pixels here: a capture that asks for them reports why, and the successor falls back to the UI.
      if (name === "get_window_state") return { content: [], structuredContent: { pid, window_id: 7, snapshot_id: "s", elements_complete: true, elements: [],
        ...((args as { include_screenshot?: boolean }).include_screenshot !== false ? { screenshot_error: "No surface." } : {}),
        window_bounds: { x: 0, y: 0, width: 100, height: 80 } } };
      if (name === "type_text") return { content: [], structuredContent: { effect: "confirmed" } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: `App ${pid}`, launch_path: `C:\\app${pid}.exe` }] } };
      if (name === "launch_app") throw new Error("launch stopped by the fixture");
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  return driver;
}

async function fixture() {
  const hostDriver = backend(10), remoteDriver = backend(20), guestDriver = backend(30);
  const host = new ComputerSession(hostDriver, () => "yolo");
  const remote = new ComputerSession(remoteDriver, () => "yolo"), guest = new ComputerSession(guestDriver, () => "yolo");
  const machineClose = vi.fn(() => remote.close()), sandboxClose = vi.fn(async () => {});
  const machine: OpenedMachine = { ref: "lab", session: remote, describe: source => `# Remote machine\nAddress: ${source}`, close: machineClose };
  const openSandbox = vi.fn(async (_cwd: string, _command: Record<string, unknown>, _signal?: AbortSignal, onMachine?: string): Promise<OpenedSandbox> =>
    ({ ref: "sb-1", session: guest, describe: source => source, close: sandboxClose, ...(onMachine ? { machine: onMachine } : {}) }));
  const start = vi.fn(async (_cwd: string, name: string) => {
    if (name !== "lab") throw new ComputerRequestError(`No machine named ${name} is configured in .pi/computer-use.json.`);
    return machine;
  });
  const resources = new ComputerResources(async () => host, async () => host.close(), openSandbox, start);
  const names = (driver: Driver) => vi.mocked(driver.call).mock.calls.map(([name]) => name);
  return { resources, hostDriver, remoteDriver, openSandbox, start, machineClose, sandboxClose, names, machineSource: computerSource("machine", "lab") };
}

test("a machine starts on first use; its windows, apps and displays come only from its own driver", async () => {
  const f = await fixture();
  const listed = await f.resources.search(address(`${f.machineSource}/windows`), cwd, "window");
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const view = await f.resources.read(address(computerSource("window", ref)), cwd, ["ui"]);
  await f.resources.perform(address(computerSource("observation", view!.details.observation_id!)), cwd, "hello", "write");
  const displays = await f.resources.read(address(`${f.machineSource}/displays`), cwd);
  expect((displays!.details.state!.displays as { display_id: string }[]).map(display => display.display_id)).toEqual(["D20"]);
  // An app address opens the app on the machine that listed it.
  const apps = await f.resources.search(address(`${f.machineSource}/apps`), cwd, "App");
  const app = (apps.details.state!.apps as { app_ref: string }[])[0].app_ref;
  await f.resources.perform(address(computerSource("app", app)), cwd, JSON.stringify({ action: "open" }), "insert");
  // The Write's successor walks the window again; repeated walks are collapsed here.
  expect(f.names(f.remoteDriver).filter((name, i, all) => name !== "get_window_state" || all[i - 1] !== "get_window_state")).toEqual(["list_windows", "get_window_state", "type_text", "get_window_state", "list_displays", "list_apps", "list_apps", "list_windows", "launch_app"]);
  expect(f.names(f.hostDriver)).toEqual([]);
  // Every use after the first reuses the started machine.
  expect(f.start).toHaveBeenCalledOnce();
});

test("an unknown machine refuses, and closing a machine releases it, its references and its sandboxes", async () => {
  const f = await fixture();
  await expect(f.resources.search(address("computer:machine/other/windows"), cwd, "")).rejects.toThrow(ComputerRequestError);
  const listed = await f.resources.search(address(`${f.machineSource}/windows`), cwd, "window");
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const view = await f.resources.read(address(computerSource("window", ref)), cwd, ["ui"]);
  const sandbox = await f.resources.perform(address(f.machineSource), cwd, JSON.stringify({ action: "open_sandbox" }), "insert");
  expect(sandbox.details.sandbox_ref).toBe("sb-1");
  expect(f.openSandbox.mock.calls[0][3]).toBe("lab");
  const closed = await f.resources.perform(address(f.machineSource), cwd, JSON.stringify({ action: "close" }), "insert");
  // The report names each released part.
  expect(closed.details.status).toBe("closed");
  expect(closed.content[0]).toMatchObject({ text: expect.stringMatching(/computer:sandbox\/sb-1: Sandbox[^\n]*destroyed[\s\S]*computer:machine\/lab: /) });
  expect(f.sandboxClose).toHaveBeenCalledOnce();
  expect(f.machineClose).toHaveBeenCalledOnce();
  expect(() => f.resources.descriptor(address(computerSource("sandbox", "sb-1")))).toThrow(/expired/);
  await expect(f.resources.perform(address(computerSource("observation", view!.details.observation_id!)), cwd, "late", "write")).rejects.toThrow(/expired/);
  // A stale remote window address never reaches this host's desktop.
  await expect(f.resources.read(address(computerSource("window", ref)), cwd, ["ui"])).rejects.toThrow(/Unknown or closed window reference[\s\S]*nothing was sent/);
  expect(f.names(f.hostDriver)).toEqual([]);
});

test("closing the computer session releases every machine, the local one included, and reports each", async () => {
  const f = await fixture();
  await f.resources.search(address(`${f.machineSource}/windows`), cwd, "");
  await f.resources.search(address("computer:machine/local/windows"), cwd, "");
  const closed = await f.resources.perform(address("computer:session"), cwd, JSON.stringify({ action: "close" }), "insert");
  expect(f.machineClose).toHaveBeenCalledOnce();
  expect(closed.details.status).toBe("closed");
  // What the model sees: a session's own close result carries a JSON projection that must not hide later parts.
  const lines = presentComputerResult(closed);
  expect(lines).toMatch(/computer:machine\/lab: /);
  expect(lines).toMatch(/computer:machine\/local: /);
  // A closed machine starts again on its next use.
  await f.resources.search(address(`${f.machineSource}/windows`), cwd, "");
  expect(f.start).toHaveBeenCalledTimes(2);
});

test("removed address forms refuse", () => {
  for (const source of ["computer:windows", "computer:apps", "computer:displays", "computer:machine/lab/display", "computer:machine/lab/display/a/b"]) expect(() => address(source)).toThrow();
  // A display without its machine names the form to use instead.
  expect(() => address("computer:display/primary")).toThrow(/computer:machine\/<name>\/display\/primary/);
});

// LPT-929, LPT-924: every address reaches the machine that issued it, and every receipt names that machine.
test("window sequences and their frames run on the machine that captured them", async () => {
  const f = await fixture();
  const listed = await f.resources.search(address(`${f.machineSource}/windows`), cwd, "window");
  expect(listed.details.machine).toBe("lab");
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const captured = await f.resources.read(address(computerSource("window", ref)), cwd, ['sequence:{"duration_ms":1}']);
  expect(captured?.details).toMatchObject({ status: "observed", machine: "lab" });
  const sequence = address(computerSource("sequence", captured!.details.sequence!.sequence_id));
  const frames = await f.resources.read(sequence, cwd, ["frames:endpoints"]);
  expect(frames?.details).toMatchObject({ status: "observed", machine: "lab" });
  expect(frames!.content.filter(block => block.type === "image")).toHaveLength(1);
  expect(presentComputerResult(frames!)).toMatch(/^Computer observed \(yolo\) on lab\n/);
  expect(f.names(f.hostDriver)).toEqual([]);
});

test("a machine's primary and listed displays are read and captured on that machine only", async () => {
  const f = await fixture();
  const primary = address(displaySource("lab", "primary"));
  const overview = await f.resources.read(primary, cwd);
  expect(overview?.details).toMatchObject({ status: "observed", machine: "lab" });
  // The display observation keeps its machine.
  expect(f.resources.descriptor(address(computerSource("observation", overview!.details.agent_image!.image_id as string)))).toContain(`Source: ${displaySource("lab", "primary")}`);
  const sequence = await f.resources.read(primary, cwd, ['sequence:{"duration_ms":1}']);
  expect(sequence?.details).toMatchObject({ status: "observed", machine: "lab" });
  const listed = await f.resources.read(address(`${f.machineSource}/displays`), cwd);
  const ref = (listed!.details.state!.displays as { display_ref: string }[])[0].display_ref;
  // The listing shows each display with its machine's address.
  expect(presentComputerResult(listed!)).toContain(displaySource("lab", ref));
  const selected = await f.resources.read(address(displaySource("lab", ref)), cwd, ['sequence:{"duration_ms":1}']);
  expect(selected?.details).toMatchObject({ status: "observed", machine: "lab" });
  const frames = await f.resources.read(address(computerSource("sequence", selected!.details.sequence!.sequence_id)), cwd, ["frames:last"]);
  expect(frames?.details.status).toBe("observed");
  // A display reference of one machine is unknown on another.
  const elsewhere = await f.resources.read(address(displaySource("local", ref)), cwd);
  expect(elsewhere?.details).toMatchObject({ status: "refused", machine: "local" });
  expect(presentComputerResult(elsewhere!)).toMatch(/Unknown or unavailable display reference/);
  expect(f.names(f.remoteDriver)).toEqual(["get_desktop_state", "get_desktop_state", "list_displays", "get_display_state"]);
  expect(f.names(f.hostDriver)).toEqual([]);
});

test("an address no machine issued is refused before anything is sent", async () => {
  const f = await fixture();
  await f.resources.search(address(`${f.machineSource}/windows`), cwd, "");
  await expect(f.resources.read(address(computerSource("window", "w-unknown")), cwd, ["ui"])).rejects.toThrow(/Unknown or closed window reference/);
  await expect(f.resources.read(address(computerSource("sequence", "seq-unknown")), cwd, ["frames:last"])).rejects.toThrow(/Sequence is unavailable/);
  await expect(f.resources.read(address(displaySource("other", "primary")), cwd)).rejects.toThrow(/No machine named other/);
  expect(f.names(f.hostDriver)).toEqual([]);
  expect(f.names(f.remoteDriver)).toEqual(["list_windows"]);
});

test("a remote browser refuses before launch when that machine's worker copy is stale or missing", async () => {
  const local = execFileSync("sha256sum", ["src/web-worker.ts", "src/aria-match.ts", require.resolve("playwright-core/package.json")], { encoding: "utf8" });
  const runner = (output: string | Error): CommandRunner => ({ spawn: vi.fn(), run: vi.fn(async () => {
    if (output instanceof Error) throw output;
    return output;
  }) });
  const current = runner(local);
  await checkRemoteWorker(current, "/pkg", "setup part machine");
  expect(current.run).toHaveBeenCalledWith("sha256sum", ["/pkg/src/web-worker.ts", "/pkg/src/aria-match.ts", "/pkg/node_modules/playwright-core/package.json"], expect.anything());
  const stale = local.replace(/^[0-9a-f]{64}/, "0".repeat(64));
  await expect(checkRemoteWorker(runner(stale), "/pkg", "setup part machine"))
    .rejects.toThrow(/out of date \(src\/web-worker\.ts\); nothing was launched\. Refresh it from this package with setup part machine/);
  await expect(checkRemoteWorker(runner(new Error("No such file")), "/pkg", "setup"))
    .rejects.toBeInstanceOf(ComputerRequestError);
});