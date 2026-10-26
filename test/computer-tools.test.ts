import { expect, test, vi } from "vitest";
import { requireComputerAddress, ComputerResources } from "../src/computer-resources.ts";
import { clipboardCommand, filesCommand, openCommand, recordCommand, waitCommand, windowCommand } from "../src/computer-tools.ts";
import type { WebBrowser, WebLauncher } from "../src/web-browser.ts";
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

test("computer_wait maps to wait_for or a single verify sample", () => {
  const conditions = [{ target: "getByRole('button', { name: 'Save' })", is: "enabled" as const }];
  expect(waitCommand({ window: "w", conditions, timeout_ms: 2000, stable: 2 })).toEqual({ action: "wait_for", conditions, timeout_ms: 2000, stable: 2 });
  expect(waitCommand({ window: "w", conditions, mode: "check" })).toEqual({ action: "verify", conditions });
  expect(() => waitCommand({ window: "w", conditions, mode: "check", timeout_ms: 10 })).toThrow("check takes one sample, so timeout_ms do not apply.");
});

test("computer_files maps put, get and list and takes only their fields", () => {
  expect(filesCommand({ machine: "m", action: "put", from: "a.txt" })).toEqual({ action: "put", from: "a.txt" });
  expect(filesCommand({ machine: "m", action: "put", from: "a.txt", name: "b.txt" })).toEqual({ action: "put", from: "a.txt", name: "b.txt" });
  expect(filesCommand({ machine: "m", action: "get", name: "b.txt", to: "out/b.txt" })).toEqual({ action: "get", name: "b.txt", to: "out/b.txt" });
  expect(filesCommand({ machine: "m", action: "list" })).toEqual({ action: "files" });
  expect(() => filesCommand({ machine: "m", action: "put" })).toThrow("put needs from.");
  expect(() => filesCommand({ machine: "m", action: "get", name: "b.txt" })).toThrow("get needs to.");
  expect(() => filesCommand({ machine: "m", action: "list", to: "x" })).toThrow("list takes no to.");
});

test("computer_clipboard reads with or without the image and writes exactly one of text or image", () => {
  expect(clipboardCommand({ machine: "m", action: "read" })).toEqual({ action: "clipboard_read" });
  expect(clipboardCommand({ machine: "m", action: "read", include_image: true })).toEqual({ action: "clipboard_read", image: true });
  expect(clipboardCommand({ machine: "m", action: "write", text: "hi" })).toEqual({ action: "clipboard_write", text: "hi" });
  expect(clipboardCommand({ machine: "m", action: "write", image: "a.png" })).toEqual({ action: "clipboard_write", image: "a.png" });
  expect(() => clipboardCommand({ machine: "m", action: "write" })).toThrow("write needs exactly one of text or image.");
  expect(() => clipboardCommand({ machine: "m", action: "write", text: "hi", image: "a.png" })).toThrow("write needs exactly one of text or image.");
  expect(() => clipboardCommand({ machine: "m", action: "read", text: "hi" })).toThrow("read takes no text.");
});

test("computer_record maps video and audio to machine commands and sequence to the Read view", () => {
  expect(recordCommand({ at: "m", action: "video_start", seconds: 30 })).toEqual({ command: { action: "record_start", seconds: 30 } });
  expect(recordCommand({ at: "m", action: "video_stop", to: "v.mp4" })).toEqual({ command: { action: "record_stop", to: "v.mp4" } });
  expect(recordCommand({ at: "m", action: "audio", seconds: 5, transcribe: true })).toEqual({ command: { action: "audio_record", seconds: 5, transcribe: true } });
  expect(recordCommand({ at: "w", action: "sequence", duration_ms: 2000, fps: 10, region: { x: 0, y: 0, width: 100, height: 50 } }))
    .toEqual({ views: ['sequence:{"duration_ms":2000,"fps":10,"region":{"x":0,"y":0,"width":100,"height":50}}'] });
  expect(() => recordCommand({ at: "m", action: "video_start" })).toThrow("video_start needs seconds.");
  expect(() => recordCommand({ at: "m", action: "audio", seconds: 400 })).toThrow("audio records at most 300 seconds.");
  expect(() => recordCommand({ at: "w", action: "sequence" })).toThrow("sequence needs duration_ms.");
  expect(() => recordCommand({ at: "w", action: "sequence", duration_ms: 5000, timeout_ms: 1000 })).toThrow("timeout_ms duration..");
  expect(() => recordCommand({ at: "m", action: "video_stop", seconds: 3 })).toThrow("video_stop takes no seconds.");
});

/** A Chrome window (pid 4100) attached to a fake Playwright worker that records page actions. */
function browserFixture() {
  const target = { pid: 4100, window_id: 77, title: "Page - Google Chrome", app_name: "chrome.exe" };
  const driver: Driver = {
    identity: vi.fn(async () => "life-77") as Driver["identity"], close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [target] } };
      throw new Error(`Unexpected native call ${name}`);
    }),
  };
  const page = vi.fn(async (_kind: string, _action?: unknown) => ({ url: "https://example.com/next", title: "Next", snapshot: "- heading \"Next\" [ref=e1]", tabs: [], events: [] }));
  const launch = vi.fn<WebLauncher>(async () => ({ browser: { close: vi.fn(async () => {}), page } as unknown as WebBrowser,
    opened: { pid: target.pid, version: "155", url: "https://example.com", title: "Page", via: "cdp" } }));
  const session = new ComputerSession(driver, () => "yolo", undefined, undefined, undefined, launch);
  const resources = new ComputerResources(async () => session, async () => session.close());
  const window = async () => {
    const ref = ((await resources.search(at("computer:machine/local/windows"), cwd, "Chrome")).details.state!.windows as { window_ref: string }[])[0].window_ref;
    expect((await session.attachBrowser(ref)).details.status).toBe("delivered");
    return at(`computer:window/${ref}`);
  };
  return { resources, page, window };
}

test("computer_browser runs a page action on the window and returns the page's next snapshot", async () => {
  const f = browserFixture();
  const window = await f.window();
  const result = await f.resources.browserAction(window, cwd, { action: "navigate", url: "https://example.com/next" });
  expect(result.details).toMatchObject({ status: "delivered", machine: "local" });
  expect(f.page).toHaveBeenLastCalledWith("act", { action: "navigate", url: "https://example.com/next" }, undefined);
  // The snapshot is the window's current observation, so its refs ground the next action.
  const id = result.details.observation_id!;
  expect((await f.resources.read(at(`computer:observation/${id}`), cwd))?.details.status).toBe("observed");
  await expect(f.resources.browserAction(window, cwd, { action: "click", target: { ref: "e1" } })).rejects.toThrow("computer_browser runs navigate, back");
  await expect(f.resources.browserAction(window, cwd, { action: "navigate", url: "file:///etc/passwd" })).rejects.toThrow("url must be HTTP(S)");
  await expect(f.resources.browserAction(at("computer:machine/local"), cwd, { action: "reload" })).rejects.toThrow("computer_browser needs the window address");
  // Refused requests never reach Playwright.
  expect(f.page).toHaveBeenCalledTimes(1);
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
  // A malformed address is refused before anything is sent, like an invalid field.
  expect((await kept.remove("computer:display/primary")).script).toMatchObject({ outcome: "refused", effect: "not-applied" });
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
