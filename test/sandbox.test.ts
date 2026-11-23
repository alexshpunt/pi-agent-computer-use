import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress, type OpenedSandbox } from "../src/computer-resources.ts";
import { ComputerSession, type Driver } from "../src/session.ts";
import { WindowsSandbox, guestFolder, sandboxConfig, sandboxOptions, waitForGuestDriver, type SandboxHost } from "../src/sandbox.ts";

const cwd = "/synthetic-sandbox-fixture";
const address = requireComputerAddress;

// LPT-1657: before the guest connects its relay, a request hangs until its 15 s timeout. Attempts are cut after 5 s,
// so a guest that comes up is answered within seconds; the last 15 s stay one long attempt.
test("waiting for a guest driver cuts silent attempts short and returns once the guest answers", async () => {
  vi.useFakeTimers();
  try {
    const limits: number[] = [];
    let up = false;
    const driver = {
      call: (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) => new Promise<{ isError?: boolean }>((resolve, reject) => {
        const started = Date.now();
        if (up) { resolve({}); return; }
        signal?.addEventListener("abort", () => { limits.push(Date.now() - started); reject(new Error("aborted")); }, { once: true });
      }),
      close: async () => {},
    };
    const waited = waitForGuestDriver(driver, undefined, 60_000);
    await vi.advanceTimersByTimeAsync(13_000);
    up = true;
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(waited).resolves.toBeUndefined();
    // Attempts start at 0, 6 and 12 s; the guest is up at 13 s and the attempt at 18 s answers.
    expect(limits).toEqual([5_000, 5_000, 5_000]);

    limits.length = 0; up = false;
    const silent = waitForGuestDriver(driver, undefined, 60_000);
    const refused = expect(silent).rejects.toThrow("did not answer within 60 s");
    await vi.advanceTimersByTimeAsync(61_000);
    await refused;
    expect(limits.slice(0, -1).every(limit => limit === 5_000)).toBe(true);
    expect(limits.at(-1)).toBeGreaterThan(5_000);
  } finally { vi.useRealTimers(); }
});

test("open_sandbox file channels default to read-only imports and one writable export in the agent's own guest folder", () => {
  const shares = sandboxOptions({ action: "open_sandbox", import: ["C:\\data\\inputs", { host: "/mnt/c/repo", guest: "D:\\repo", writable: true }], export: "C:\\out" }).shares;
  expect(shares.map(share => [share.host, guestFolder(share, "sb-1"), share.writable])).toEqual([
    ["C:\\data\\inputs", "C:\\pi\\agents\\sb-1\\import\\inputs", false],
    ["/mnt/c/repo", "D:\\repo", true],
    ["C:\\out", "C:\\pi\\agents\\sb-1\\export", true],
  ]);
  expect(sandboxOptions({ action: "open_sandbox" }).shares).toEqual([]);
  expect(() => sandboxOptions({ action: "open_sandbox", clipboard: true })).toThrow(/only import and export/);
  expect(() => sandboxOptions({ action: "open_sandbox", import: [{ host: "C:\\a", guest: "C:\\pi\\runtime" }] })).toThrow(/outside C:\\pi/);
  expect(() => sandboxOptions({ action: "open_sandbox", import: ["C:\\a\\same", "D:\\b\\same"] })).toThrow(/same guest folder/);
});

test("the sandbox maps only the runtime, its config and an output folder; agents add their folders later", () => {
  const wsb = sandboxConfig("C:\\rt & co", "C:\\w\\config", "C:\\w\\out");
  expect(wsb).toContain("<ClipboardRedirection>Disable</ClipboardRedirection>");
  expect(wsb).toContain("<HostFolder>C:\\rt &amp; co</HostFolder><SandboxFolder>C:\\pi\\runtime</SandboxFolder><ReadOnly>true</ReadOnly>");
  expect(wsb).toContain("<HostFolder>C:\\w\\out</HostFolder><SandboxFolder>C:\\pi\\out</SandboxFolder><ReadOnly>false</ReadOnly>");
  expect(wsb.match(/<MappedFolder>/g)).toHaveLength(3);
});

/**
 * A Windows host whose shared sandbox folder is a real temporary folder. `failAt` stops a launch; `foreign` runs a
 * sandbox computer use did not start; `stale` reports the first shared state found as stale. Every PowerShell script is recorded.
 */
async function fakeHost(options: { failAt?: "session" | "id"; foreign?: boolean; stale?: boolean; failForward?: number } = {}) {
  const local = await mkdtemp(path.join(tmpdir(), "pi-sandbox-test-"));
  const shared = path.join(local, "shared");
  const scripts: string[] = [];
  const forwarded: number[] = [], closedForwards: number[] = [];
  let launched = 0, stale = options.stale === true;
  const host: SandboxHost = {
    async path(value, to) {
      if (to === "windows") return value.startsWith("/mnt/c/") ? "C:\\" + value.slice(7).replaceAll("/", "\\") : "\\\\wsl.localhost\\Ubuntu" + value.replaceAll("/", "\\");
      if (value === "C:\\Local\\PiComputerUse\\sandboxes") return local;
      throw new Error(`unexpected path ${value}`);
    },
    async powershell(script) {
      scripts.push(script);
      if (script.includes("sandbox=")) return "sandbox=True;wsb=True;missing=;local=C:\\Local\n";
      if (script.includes("'CreateNew'") && script.includes("\\lock'")) { await writeFile(path.join(shared, "lock"), "", { flag: "wx" }); return ""; }
      if (script.includes("'foreign'")) {
        const state = await readFile(path.join(shared, "sandbox.json"), "utf8").catch(() => "");
        if (state && stale) { stale = false; return "stale\n"; }
        return state ? "alive\n" : options.foreign ? "foreign\n" : "none\n";
      }
      if (script.includes("Start-Process explorer.exe")) launched++;
      if (script.includes("Get-Process vmmemWindowsSandbox") && script.includes("Select-Object -First 1")) {
        if (options.failAt === "id") throw new Error("Cancelled while starting the sandbox.");
        return "11111111-2222-3333-4444-555555555555\n";
      }
      if (script.includes("cmd.exe /c exit 0") && options.failAt === "session") throw new Error("The sandbox user session did not become available within 120 s.");
      if (script.includes(".IpV4Address")) return "172.20.0.2\n";
      if (script.includes("host-watchdog.ps1")) return "5151\n";
      return "";
    },
    mkdir: async dir => { await mkdir(dir, { recursive: true }); },
    writeFile: (file, content) => writeFile(file, content),
    readFile: file => {
      const relay = /relay-(4780[0234])\.txt$/.exec(file);
      if (relay) return Promise.resolve({ 47800: "12001 4242", 47802: "12003 4243", 47803: "12004 4244", 47804: "12005 4245" }[relay[1] as "47800"]);
      return readFile(file, "utf8").catch(() => "");
    },
    remove: target => rm(target, { recursive: true, force: true }),
    forward: async port => {
      forwarded.push(port);
      if (forwarded.length === options.failForward) throw new Error("Fixture forward failure");
      return { port, close: () => { closedForwards.push(port); } };
    },
  };
  return { host, scripts, local, shared, forwarded, closedForwards, launched: () => launched, cleanup: () => rm(local, { recursive: true, force: true }) };
}
const runtime = "/mnt/c/runtime/cua-driver.exe";

// LPT-1809: Windows runs one sandbox at a time, so every agent on the machine shares it.
test("the first agent starts the shared sandbox and later agents attach to the same one", async () => {
  const f = await fakeHost();
  let first: WindowsSandbox | undefined, second: WindowsSandbox | undefined;
  try {
    first = await WindowsSandbox.open(f.host, runtime, { shares: [] });
    second = await WindowsSandbox.open(f.host, runtime, sandboxOptions({ action: "open_sandbox", export: "C:\\out" }));
    expect(f.launched()).toBe(1);
    expect([first.started, second.started]).toEqual([true, false]);
    expect(second.id).toBe(first.id);
    expect(second.endpoint).toMatchObject({ token: first.endpoint!.token, identityAuth: first.endpoint!.identityAuth });
    expect(f.forwarded).toEqual([12001, 12003, 12004, 12005, 12001, 12003, 12004, 12005]);
    expect(first.endpoint?.leasePort).toBe(12004);
    // The guest has the lease service; the watchdog runs on the host.
    expect(await readdir(path.join(f.shared, "config"))).toEqual(expect.arrayContaining(["guest-lease.cs", "guest-lease.ps1", "host-watchdog.ps1"]));
    expect(JSON.parse(await readFile(path.join(f.shared, "sandbox.json"), "utf8")).watchdog.pid).toBe(5151);
    expect((await readdir(path.join(f.shared, "agents"))).sort()).toEqual([`${first.ref}.json`, `${second.ref}.json`].sort());
    expect(f.scripts.some(script => script.includes(`share --id 11111111-2222-3333-4444-555555555555 -f 'C:\\out' -s 'C:\\pi\\agents\\${second!.ref}\\export' --allow-write`))).toBe(true);
    expect(await readdir(f.shared)).not.toContain("lock");

    // Leaving keeps the sandbox for the others: nothing is stopped, only this agent's presence and tunnels go.
    const before = f.scripts.length;
    await first.close();
    expect(f.scripts.slice(before).some(script => script.includes("stop --id") || script.includes("Stop-Process"))).toBe(false);
    expect(await readdir(path.join(f.shared, "agents"))).toEqual([`${second.ref}.json`]);
    expect(f.closedForwards).toEqual([12001, 12003, 12004, 12005]);
  } finally { await first?.close(); await second?.close(); await f.cleanup(); }
});

test("an agent with another runtime does not attach to the shared sandbox", async () => {
  const f = await fakeHost();
  let first: WindowsSandbox | undefined;
  try {
    first = await WindowsSandbox.open(f.host, runtime, { shares: [] });
    await expect(WindowsSandbox.open(f.host, "/mnt/c/other-runtime/cua-driver.exe", { shares: [] })).rejects.toThrow(/another computer-use runtime/);
    expect(f.launched()).toBe(1);
    expect(await readdir(path.join(f.shared, "agents"))).toEqual([`${first.ref}.json`]);
  } finally { await first?.close(); await f.cleanup(); }
});

test("an agent does not attach to a sandbox another version of computer use started", async () => {
  const f = await fakeHost();
  try {
    await mkdir(path.join(f.shared, "agents"), { recursive: true });
    await writeFile(path.join(f.shared, "sandbox.json"), JSON.stringify({ version: 1, id: "old", relays: { lease: { port: 1 } } }));
    await expect(WindowsSandbox.open(f.host, runtime, { shares: [] })).rejects.toThrow(/another version of computer use/);
    expect(f.launched()).toBe(0);
    expect(await readdir(path.join(f.shared, "agents"))).toEqual([]);
  } finally { await f.cleanup(); }
});

// Killing the sandbox client and server leaves the VM running, and Windows then refuses a new sandbox.
test("a stale shared sandbox is stopped with wsb before a new one starts", async () => {
  const f = await fakeHost({ stale: true });
  let sandbox: WindowsSandbox | undefined;
  try {
    await mkdir(path.join(f.shared, "agents"), { recursive: true });
    await writeFile(path.join(f.shared, "sandbox.json"), JSON.stringify({ version: 2, id: "99999999-2222-3333-4444-555555555555" }));
    sandbox = await WindowsSandbox.open(f.host, runtime, { shares: [] });
    const stop = f.scripts.findIndex(script => script.includes("stop --id $s.id"));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(f.scripts.findIndex(script => script.includes("Start-Process explorer.exe")));
    expect(f.launched()).toBe(1);
    expect(sandbox.id).toBe("11111111-2222-3333-4444-555555555555");
  } finally { await sandbox?.close(); await f.cleanup(); }
});

test("a failed identity forward releases the already opened driver tunnel and the agent's presence", async () => {
  const f = await fakeHost({ failForward: 2 });
  try {
    await expect(WindowsSandbox.open(f.host, runtime, { shares: [] })).rejects.toBeInstanceOf(Error);
    expect(f.closedForwards).toEqual([12001]);
    expect(await readdir(path.join(f.shared, "agents"))).toEqual([]);
  } finally { await f.cleanup(); }
});

test("a sandbox that fails after launch is stopped and its state removed", async () => {
  const f = await fakeHost({ failAt: "session" });
  try {
    await expect(WindowsSandbox.open(f.host, runtime, sandboxOptions({ action: "open_sandbox" }))).rejects.toThrow(/user session/);
    const close = f.scripts.find(script => script.includes("stop --id 11111111-2222-3333-4444-555555555555"));
    expect(close).toBeDefined();
    expect((await readdir(f.shared)).sort()).toEqual(["agents"]);
  } finally { await f.cleanup(); }
});

test("a launch cancelled before its id is known stops its sandbox and the client it started", async () => {
  const f = await fakeHost({ failAt: "id" });
  try {
    await expect(WindowsSandbox.open(f.host, runtime, sandboxOptions({ action: "open_sandbox" }))).rejects.toThrow(/Cancelled/);
    const close = f.scripts.find(script => script.includes("foreach ($id in $ids)"))!;
    expect(close).toMatch(/WindowsSandboxRemoteSession .*StartTime -ge .*Stop-Process -Force/);
    expect((await readdir(f.shared)).sort()).toEqual(["agents"]);
  } finally { await f.cleanup(); }
});

// A second launch only showed an error dialog and timed out after 120 s (LPT-838).
test("a sandbox computer use did not start refuses the launch at once and starts nothing", async () => {
  const f = await fakeHost({ foreign: true });
  try {
    await expect(WindowsSandbox.open(f.host, runtime, sandboxOptions({ action: "open_sandbox" })))
      .rejects.toThrow(/did not start is running on this machine, and Windows allows only one.*Nothing was started/);
    expect(f.launched()).toBe(0);
    expect(f.scripts.some(script => script.includes("Stop-Process"))).toBe(false);
    expect(await readdir(f.shared)).toEqual(["agents"]);
  } finally { await f.cleanup(); }
});

test("runtime folders outside a Windows drive are refused before any sandbox starts", async () => {
  const f = await fakeHost({ failAt: "session" });
  try {
    await expect(WindowsSandbox.open(f.host, "/home/user/runtime/cua-driver.exe", sandboxOptions({ action: "open_sandbox" }))).rejects.toThrow(/Windows drive/);
    expect(f.launched()).toBe(0);
  } finally { await f.cleanup(); }
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
