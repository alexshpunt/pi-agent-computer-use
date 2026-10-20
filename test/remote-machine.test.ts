import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { computerSource } from "../src/computer-address.ts";
import { ComputerRequestError, ComputerResources, requireComputerAddress, type OpenedMachine, type OpenedSandbox } from "../src/computer-resources.ts";
import { loadComputerConfig } from "../src/config.ts";
import { checkRemoteWorker } from "../src/machine.ts";
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
  await write({ zinpc: { ssh: "zinpc-benchmark", command: "/mnt/c/run/cua-driver.exe", runtime: "windows-desktop", node: "/mnt/c/node.exe", package: "/home/u/pkg" } });
  expect((await loadComputerConfig(dir)).machines?.zinpc).toEqual({ ssh: "zinpc-benchmark", command: "/mnt/c/run/cua-driver.exe", runtime: "windows-desktop", node: "/mnt/c/node.exe", package: "/home/u/pkg" });
  for (const bad of [{ "Bad Name": { ssh: "a", command: "/x" } }, { pc: { ssh: "a", command: "relative/cua.exe" } }, { pc: { ssh: "a", command: "/x", extra: 1 } }, { pc: { ssh: "a", command: "/x", runtime: "unknown" } }, []]) {
    await write(bad);
    await expect(loadComputerConfig(dir)).rejects.toThrow(/Invalid machines/);
  }
});

/** A fake native backend with one window and one display. */
function backend(pid: number) {
  const driver: Driver = {
    identity: vi.fn(async () => `life-${pid}`), close: vi.fn(async () => {}), selectedDisplays: true,
    call: vi.fn<Driver["call"]>(async (name) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid, window_id: 7, title: `window ${pid}` }] } };
      if (name === "list_displays") return { content: [], structuredContent: { platform: "windows", topology_id: `t${pid}`, displays: [{ display_id: `D${pid}`, primary: true,
        monitor_handle: `0x${pid}`, monitor_device_paths: [`\\\\?\\DISPLAY#${pid}`], bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        work_area: { x: 0, y: 0, width: 1920, height: 1040 }, scale_factor: 1, dpi: 96 }] } };
      if (name === "get_window_state") return { content: [], structuredContent: { pid, window_id: 7, snapshot_id: "s", elements_complete: true, elements: [],
        window_bounds: { x: 0, y: 0, width: 100, height: 80 } } };
      if (name === "type_text") return { content: [], structuredContent: { effect: "confirmed" } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  return driver;
}

async function fixture() {
  const hostDriver = backend(10), remoteDriver = backend(20), guestDriver = backend(30);
  const host = new ComputerSession(hostDriver, () => "yolo");
  const remote = new ComputerSession(remoteDriver, () => "yolo"), guest = new ComputerSession(guestDriver, () => "yolo");
  const machineClose = vi.fn(async () => { await remote.close(); }), sandboxClose = vi.fn(async () => {});
  const machine: OpenedMachine = { ref: "zinpc", session: remote, describe: source => `# Remote machine\nAddress: ${source}`, close: machineClose };
  const openSandbox = vi.fn(async (_cwd: string, _command: Record<string, unknown>, _signal?: AbortSignal, onMachine?: string): Promise<OpenedSandbox> =>
    ({ ref: "sb-1", session: guest, describe: source => source, close: sandboxClose, ...(onMachine ? { machine: onMachine } : {}) }));
  const connect = vi.fn(async (_cwd: string, name: string) => {
    if (name !== "zinpc") throw new ComputerRequestError(`No machine named ${name} is configured in .pi/computer-use.json.`);
    return machine;
  });
  const resources = new ComputerResources(async () => host, async () => host.close(), openSandbox, connect);
  const names = (driver: Driver) => vi.mocked(driver.call).mock.calls.map(([name]) => name);
  return { resources, hostDriver, remoteDriver, openSandbox, connect, machineClose, sandboxClose, names, machineSource: computerSource("machine", "zinpc") };
}

test("a machine's windows and displays are found, read and operated only through its own driver", async () => {
  const f = await fixture();
  const connected = await f.resources.perform(address("computer:session"), cwd, JSON.stringify({ action: "connect", machine: "zinpc" }), "insert");
  expect(connected.details).toMatchObject({ status: "delivered", machine_ref: "zinpc" });
  const listed = await f.resources.search(address(f.machineSource), cwd, "window");
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const view = await f.resources.read(address(computerSource("window", ref)), cwd, ["ui"]);
  await f.resources.perform(address(computerSource("observation", view!.details.observation_id!)), cwd, "hello", "write");
  const displays = await f.resources.read(address(f.machineSource), cwd);
  expect((displays!.details.state!.displays as { display_id: string }[]).map(display => display.display_id)).toEqual(["D20"]);
  expect(f.names(f.remoteDriver)).toEqual(["list_windows", "get_window_state", "type_text", "list_displays"]);
  expect(f.names(f.hostDriver)).toEqual([]);
  // Connecting again reuses the open connection.
  await f.resources.perform(address("computer:session"), cwd, JSON.stringify({ action: "connect", machine: "zinpc" }), "insert");
  expect(f.connect).toHaveBeenCalledOnce();
});

test("an unknown machine refuses, and disconnect retires the machine, its references and its sandboxes", async () => {
  const f = await fixture();
  await expect(f.resources.perform(address("computer:session"), cwd, JSON.stringify({ action: "connect", machine: "other" }), "insert")).rejects.toThrow(ComputerRequestError);
  await f.resources.perform(address("computer:session"), cwd, JSON.stringify({ action: "connect", machine: "zinpc" }), "insert");
  const listed = await f.resources.search(address(f.machineSource), cwd, "window");
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const view = await f.resources.read(address(computerSource("window", ref)), cwd, ["ui"]);
  const sandbox = await f.resources.perform(address(f.machineSource), cwd, JSON.stringify({ action: "open_sandbox" }), "insert");
  expect(sandbox.details.sandbox_ref).toBe("sb-1");
  expect(f.openSandbox.mock.calls[0][3]).toBe("zinpc");
  const closed = await f.resources.perform(address(f.machineSource), cwd, JSON.stringify({ action: "disconnect" }), "insert");
  expect(closed.details).toMatchObject({ status: "closed", machine_ref: "zinpc" });
  expect(f.sandboxClose).toHaveBeenCalledOnce();
  expect(f.machineClose).toHaveBeenCalledOnce();
  expect(() => f.resources.descriptor(address(f.machineSource))).toThrow(/expired/);
  expect(() => f.resources.descriptor(address(computerSource("sandbox", "sb-1")))).toThrow(/expired/);
  await expect(f.resources.perform(address(computerSource("observation", view!.details.observation_id!)), cwd, "late", "write")).rejects.toThrow(/expired/);
  // A stale remote window address never reaches this host's desktop.
  const late = await f.resources.read(address(computerSource("window", ref)), cwd, ["ui"]);
  expect(late?.details.status).toBe("refused");
  expect(f.names(f.hostDriver).filter(name => name !== "list_windows")).toEqual([]);
});

test("closing the computer session disconnects every machine", async () => {
  const f = await fixture();
  await f.resources.perform(address("computer:session"), cwd, JSON.stringify({ action: "connect", machine: "zinpc" }), "insert");
  await f.resources.perform(address("computer:session"), cwd, JSON.stringify({ action: "close" }), "insert");
  expect(f.machineClose).toHaveBeenCalledOnce();
  expect(() => f.resources.descriptor(address(f.machineSource))).toThrow(/expired/);
});

test("a remote browser refuses before launch when that machine's worker copy is stale or missing", async () => {
  const local = execFileSync("sha256sum", ["src/web-worker.ts", require.resolve("playwright-core/package.json")], { encoding: "utf8" });
  const runner = (output: string | Error): CommandRunner => ({ spawn: vi.fn(), run: vi.fn(async () => {
    if (output instanceof Error) throw output;
    return output;
  }) });
  const current = runner(local);
  await checkRemoteWorker(current, "/pkg", "scripts/setup-remote-machine.sh zinpc /rt zinpc");
  expect(current.run).toHaveBeenCalledWith("sha256sum", ["/pkg/src/web-worker.ts", "/pkg/node_modules/playwright-core/package.json"], expect.anything());
  const stale = local.replace(/^[0-9a-f]{64}/, "0".repeat(64));
  await expect(checkRemoteWorker(runner(stale), "/pkg", "scripts/setup-remote-machine.sh zinpc /rt zinpc"))
    .rejects.toThrow(/out of date \(src\/web-worker\.ts\); nothing was launched\. Refresh it from this package with scripts\/setup-remote-machine\.sh zinpc \/rt zinpc/);
  await expect(checkRemoteWorker(runner(new Error("No such file")), "/pkg", "setup"))
    .rejects.toBeInstanceOf(ComputerRequestError);
});