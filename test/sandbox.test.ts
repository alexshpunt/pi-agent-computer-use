import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress, type OpenedSandbox } from "../src/computer-resources.ts";
import { ComputerSession, type Driver } from "../src/session.ts";
import { WindowsSandbox, sandboxConfig, sandboxOptions, type SandboxHost } from "../src/sandbox.ts";

const cwd = "/synthetic-sandbox-fixture";
const address = requireComputerAddress;

test("open_sandbox file channels default to read-only imports and one writable export", () => {
  expect(sandboxOptions({ action: "open_sandbox", import: ["C:\\data\\inputs", { host: "/mnt/c/repo", guest: "D:\\repo", writable: true }], export: "C:\\out" }).shares).toEqual([
    { host: "C:\\data\\inputs", guest: "C:\\pi\\import\\inputs", writable: false },
    { host: "/mnt/c/repo", guest: "D:\\repo", writable: true },
    { host: "C:\\out", guest: "C:\\pi\\export", writable: true },
  ]);
  expect(sandboxOptions({ action: "open_sandbox" }).shares).toEqual([]);
  expect(() => sandboxOptions({ action: "open_sandbox", clipboard: true })).toThrow(/only import and export/);
  expect(() => sandboxOptions({ action: "open_sandbox", import: [{ host: "C:\\a", guest: "C:\\pi\\runtime" }] })).toThrow(/outside C:\\pi/);
  expect(() => sandboxOptions({ action: "open_sandbox", import: ["C:\\a\\same", "D:\\b\\same"] })).toThrow(/same guest folder/);
});

test("the sandbox shares only the runtime, its own config, an output folder and requested folders", () => {
  const wsb = sandboxConfig("C:\\rt", "C:\\w\\config", "C:\\w\\out", [{ host: "C:\\in & out", guest: "C:\\pi\\import\\x", writable: false }]);
  expect(wsb).toContain("<ClipboardRedirection>Disable</ClipboardRedirection>");
  expect(wsb).toContain("<HostFolder>C:\\rt</HostFolder><SandboxFolder>C:\\pi\\runtime</SandboxFolder><ReadOnly>true</ReadOnly>");
  expect(wsb).toContain("<HostFolder>C:\\w\\out</HostFolder><SandboxFolder>C:\\pi\\out</SandboxFolder><ReadOnly>false</ReadOnly>");
  expect(wsb).toContain("<HostFolder>C:\\in &amp; out</HostFolder><SandboxFolder>C:\\pi\\import\\x</SandboxFolder><ReadOnly>true</ReadOnly>");
  expect(wsb.match(/<MappedFolder>/g)).toHaveLength(4);
});

/** A host whose sandbox launch stops at `failAt`; every script is recorded. */
async function fakeHost(failAt: "session" | "id", running = false) {
  const local = await mkdtemp(path.join(tmpdir(), "pi-sandbox-test-"));
  const scripts: string[] = [];
  const host: SandboxHost = {
    async path(value, to) {
      if (to === "windows") return value.startsWith("/mnt/c/") ? "C:\\" + value.slice(7).replaceAll("/", "\\") : "\\\\wsl.localhost\\Ubuntu" + value.replaceAll("/", "\\");
      if (value === "C:\\Local\\PiComputerUse\\sandboxes") return local;
      throw new Error(`unexpected path ${value}`);
    },
    async powershell(script) {
      scripts.push(script);
      if (script.includes("sandbox=")) return "sandbox=True;wsb=True;missing=;local=C:\\Local\n";
      if (script.includes("did not start within")) {
        if (failAt === "id") throw new Error("Cancelled while starting the sandbox.");
        return "11111111-2222-3333-4444-555555555555\n";
      }
      if (script.includes("user session did not become available")) throw new Error("The sandbox user session did not become available within 120 s.");
      if (script.includes("Get-Process WindowsSandboxRemoteSession -ErrorAction SilentlyContinue) { 'running' }")) return running ? "running\n" : "";
      return "";
    },
    mkdir: async dir => { await mkdir(dir, { recursive: true }); },
    writeFile: (file, content) => writeFile(file, content),
    readFile: file => readFile(file, "utf8").catch(() => ""),
    remove: dir => rm(dir, { recursive: true, force: true }),
    forward: async port => ({ port, close: () => {} }),
  };
  return { host, scripts, local };
}

test("a sandbox that fails after launch is stopped and its host folder removed", async () => {
  const { host, scripts, local } = await fakeHost("session");
  await expect(WindowsSandbox.open(host, "/mnt/c/runtime/cua-driver.exe", sandboxOptions({ action: "open_sandbox" }))).rejects.toThrow(/user session/);
  const close = scripts.at(-1)!;
  expect(close).toContain("stop --id 11111111-2222-3333-4444-555555555555");
  expect(await readdir(local)).toEqual([]);
});

test("a launch cancelled before its id is known stops its sandbox and the client it started", async () => {
  const { host, scripts, local } = await fakeHost("id");
  await expect(WindowsSandbox.open(host, "/mnt/c/runtime/cua-driver.exe", sandboxOptions({ action: "open_sandbox" }))).rejects.toThrow(/Cancelled/);
  const close = scripts.at(-1)!;
  expect(close).toContain("foreach ($id in $ids)");
  expect(close).toMatch(/WindowsSandboxRemoteSession .*StartTime -ge .*Stop-Process -Force/);
  expect(await readdir(local)).toEqual([]);
});

// Windows runs one sandbox at a time; a second launch only showed an error dialog and timed out after 120 s (LPT-838).
test("another running sandbox refuses the launch at once and starts nothing", async () => {
  const { host, scripts, local } = await fakeHost("id", true);
  await expect(WindowsSandbox.open(host, "/mnt/c/runtime/cua-driver.exe", sandboxOptions({ action: "open_sandbox" })))
    .rejects.toThrow(/already running on this machine, and Windows allows only one.*Nothing was started/);
  expect(scripts.some(script => script.includes("explorer.exe"))).toBe(false);
  expect(scripts.filter(script => !script.includes("'running'")).some(script => script.includes("Stop-Process"))).toBe(false);
  expect(await readdir(local)).toEqual([]);
});

test("runtime folders outside a Windows drive are refused before any sandbox starts", async () => {
  const { host, scripts } = await fakeHost("session");
  await expect(WindowsSandbox.open(host, "/home/user/runtime/cua-driver.exe", sandboxOptions({ action: "open_sandbox" }))).rejects.toThrow(/Windows drive/);
  expect(scripts.some(script => script.includes("explorer.exe"))).toBe(false);
});

/** A fake native backend with one window; `domain` marks a sandbox guest. */
function backend(pid: number, domain?: "windows-sandbox") {
  const driver: Driver = {
    ...(domain ? { sourceDomain: domain } : {}),
    identity: vi.fn(async () => `life-${pid}`), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid, window_id: 7, title: `window ${pid}` }] } };
      // No pixels here: a capture that asks for them reports why, and the successor falls back to the UI.
      if (name === "get_window_state") return { content: [], structuredContent: { pid, window_id: 7, snapshot_id: "s", elements_complete: true, elements: [],
        ...((args as { include_screenshot?: boolean }).include_screenshot !== false ? { screenshot_error: "No surface." } : {}),
        window_bounds: { x: 0, y: 0, width: 100, height: 80 } } };
      if (name === "type_text") return { content: [], structuredContent: { effect: "confirmed" } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  return driver;
}

async function routing() {
  const hostDriver = backend(10), guestDriver = backend(20, "windows-sandbox");
  const host = new ComputerSession(hostDriver, () => "yolo"), guest = new ComputerSession(guestDriver, () => "yolo");
  const close = vi.fn(async () => {});
  const sandbox: OpenedSandbox = { ref: "sb-test", session: guest, describe: source => `# Windows Sandbox\nAddress: ${source}`, close };
  const resources = new ComputerResources(async () => host, async () => host.close(), async () => sandbox);
  const opened = await resources.perform(address("computer:machine/local"), cwd, JSON.stringify({ action: "open_sandbox" }));
  return { hostDriver, guestDriver, resources, opened, close, sandboxSource: computerSource("sandbox", "sb-test") };
}

test("guest windows are found, read and operated only through the sandbox's own driver", async () => {
  const f = await routing();
  expect(f.opened.details).toMatchObject({ status: "delivered", sandbox_ref: "sb-test" });
  const listed = await f.resources.search(address(f.sandboxSource), cwd, "window");
  const row = (listed.details.state!.windows as { window_ref: string; source_identity: { domain: string } }[])[0];
  expect(row.source_identity.domain).toBe("windows-sandbox");
  const view = await f.resources.read(address(computerSource("window", row.window_ref)), cwd, ["ui"]);
  expect(view?.details.status).toBe("observed");
  await f.resources.perform(address(computerSource("observation", view!.details.observation_id!)), cwd, JSON.stringify({ action: "type_text", text: "hello" }));
  const names = (driver: Driver) => vi.mocked(driver.call).mock.calls.map(([name]) => name);
  // The Write's successor walks the window again; repeated walks are collapsed here.
  expect(names(f.guestDriver).filter((name, i, all) => name !== "get_window_state" || all[i - 1] !== "get_window_state")).toEqual(["list_windows", "get_window_state", "type_text", "get_window_state"]);
  expect(names(f.hostDriver)).toEqual([]);
  expect(f.resources.descriptor(address(f.sandboxSource))).toContain(f.sandboxSource);
});

test("destroying a sandbox retires its address and guest references", async () => {
  const f = await routing();
  const listed = await f.resources.search(address(f.sandboxSource), cwd, "window");
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const view = await f.resources.read(address(computerSource("window", ref)), cwd, ["ui"]);
  const closed = await f.resources.delete(f.sandboxSource, cwd);
  expect(closed.details).toMatchObject({ status: "closed", sandbox_ref: "sb-test" });
  expect(f.close).toHaveBeenCalledOnce();
  expect(() => f.resources.descriptor(address(f.sandboxSource))).toThrow(/expired/);
  await expect(f.resources.perform(address(computerSource("observation", view!.details.observation_id!)), cwd, JSON.stringify({ action: "type_text", text: "late" }))).rejects.toThrow(/expired/);
});

test("closing the computer session destroys its sandboxes", async () => {
  const f = await routing();
  await f.resources.delete("computer:session", cwd);
  expect(f.close).toHaveBeenCalledOnce();
  expect(() => f.resources.descriptor(address(f.sandboxSource))).toThrow(/expired/);
});
