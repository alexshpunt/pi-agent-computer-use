import { expect, test, vi } from "vitest";
import { requireComputerAddress, ComputerResources } from "../src/computer-resources.ts";
import { openCommand, windowCommand } from "../src/computer-tools.ts";
import type { MachineHost } from "../src/machine-host.ts";
import { deleteComputer } from "../src/provider.ts";
import { ComputerSession, type ComputerMode, type Driver } from "../src/session.ts";

const cwd = "/synthetic-computer-tools";
const at = (source: string) => requireComputerAddress(source);

// LPT-934: each typed tool turns its fields into exactly one existing command.
test("computer_open opens one thing, chosen by its fields and the address", () => {
  const machine = at("computer:machine/lab");
  expect(openCommand(machine, { at: "", app: "Notepad" })).toEqual({ action: "open", app: "Notepad" });
  expect(openCommand(machine, { at: "", path: "C:\\Tools\\app.exe", args: ["--x"], debugging: true })).toEqual({ action: "open", path: "C:\\Tools\\app.exe", args: ["--x"], debugging: true });
  expect(openCommand(machine, { at: "", url: "https://example.com" })).toEqual({ action: "open_browser", url: "https://example.com" });
  expect(openCommand(machine, { at: "", browser: "msedge", profile: "agent" })).toEqual({ action: "open_browser", browser: "msedge", profile: "agent" });
  expect(openCommand(machine, { at: "", sandbox: { export: "C:\\out" } })).toEqual({ action: "open_sandbox", export: "C:\\out" });
  expect(openCommand(machine, { at: "", isolated_session: true })).toEqual({ action: "open_session" });
  expect(openCommand(at("computer:app/a1"), { at: "" })).toEqual({ action: "open" });
  expect(openCommand(at("computer:window/w1"), { at: "" })).toEqual({ action: "attach_browser" });
  expect(openCommand(at("computer:sandbox/s1"), { at: "", app: "Notepad" })).toEqual({ action: "open", app: "Notepad" });
  expect(() => openCommand(machine, { at: "", app: "Notepad", url: "https://example.com" })).toThrow("Open one thing at a time: app and browser");
  expect(() => openCommand(machine, { at: "", app: "Notepad", args: ["x"] })).toThrow("args and debugging go with path");
  expect(() => openCommand(machine, { at: "" })).toThrow("Name what to open");
  expect(() => openCommand(at("computer:window/w1"), { at: "", app: "Notepad" })).toThrow("A window address attaches Playwright");
  expect(() => openCommand(at("computer:sandbox/s1"), { at: "", url: "https://example.com" })).toThrow("A sandbox opens apps by app or path");
  expect(() => openCommand(at("computer:machine/lab/windows"), { at: "", app: "Notepad" })).toThrow("Open at computer:machine/<name>");
});

test("computer_window takes exactly the fields of its action", () => {
  expect(windowCommand({ window: "w", action: "move", x: -5, y: 10 })).toEqual({ action: "move", x: -5, y: 10, unit: "windows_desktop_pixels" });
  expect(windowCommand({ window: "w", action: "resize", width: 800, height: 600 })).toEqual({ action: "resize", width: 800, height: 600, unit: "windows_desktop_pixels" });
  expect(windowCommand({ window: "w", action: "restore" })).toEqual({ action: "restore" });
  expect(() => windowCommand({ window: "w", action: "move", x: 1 })).toThrow("move needs x and y and nothing else.");
  expect(() => windowCommand({ window: "w", action: "focus", width: 1 })).toThrow("focus takes no coordinates or size.");
});

/** One window (pid 10, id 7) a session can list and observe; the host decides how a close request ends. */
function fixture(outcome: "closed" | "open" | "refused") {
  let open = true, mode: ComputerMode = "yolo";
  const driver: Driver = {
    identity: vi.fn(async () => open ? "life-7" : undefined) as Driver["identity"],
    close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: open ? [{ pid: 10, window_id: 7, title: "Editor" }] : [] } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  const closeWindow = vi.fn(async () => { if (outcome === "closed") open = false; return outcome; });
  const session = new ComputerSession(driver, () => mode, undefined, undefined, undefined, undefined, { closeWindow, removeFiles: async () => {} } as unknown as MachineHost);
  const resources = new ComputerResources(async () => session, async () => session.close());
  const window = async () => ((await resources.search(at("computer:machine/local/windows"), cwd, "Editor")).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const remove = (source: string) => deleteComputer(resources, source, { path: source }, cwd);
  return { resources, closeWindow, window, remove, safe: () => { mode = "safe"; } };
}

test("Delete closes a window like its close button, and its address expires", async () => {
  const f = fixture("closed");
  const ref = await f.window();
  const closed = await f.remove(`computer:window/${ref}`);
  expect(closed.data).toMatchObject({ ok: true, status: "closed", machine: "local" });
  expect(closed.script).toMatchObject({ action: "close", outcome: "closed" });
  expect(f.closeWindow).toHaveBeenCalledWith(10, 7, 5000);
  expect((await f.remove(`computer:window/${ref}`)).summary).toContain("Unknown or closed window reference");
});

test("Delete reports a window that stays open and refuses what it cannot close", async () => {
  const kept = fixture("open");
  const ref = await kept.window();
  const result = await kept.remove(`computer:window/${ref}`);
  expect(result.data).toMatchObject({ ok: true, status: "delivered" });
  expect(result.summary).toContain("still open after 5 s");
  // Force kills only processes this session started.
  expect((await kept.remove(`computer:window/${ref}?force=true`)).summary).toContain("Only windows this session opened can be force-closed");
  expect((await kept.remove("computer:machine/local?force=true")).summary).toContain("?force=true applies to window addresses only.");
  expect((await kept.remove("computer:machine/local/windows")).summary).toContain("Delete closes a window, a sandbox or isolated session, a machine or computer:session.");

  // Safe mode closes only windows this session opened, like any other input.
  const safe = fixture("closed");
  const foreign = await safe.window();
  safe.safe();
  const refused = await safe.remove(`computer:window/${foreign}`);
  expect(refused.data).toMatchObject({ ok: false, status: "refused" });
  expect(refused.summary).toContain("Safe mode allows only windows opened by this session.");
  expect(safe.closeWindow).not.toHaveBeenCalled();
  const session = await kept.remove("computer:session");
  expect(session.data).toMatchObject({ ok: true });
});
