import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";
import { WebError, type WebBrowser, type WebLauncher } from "../src/web-browser.ts";
import type { WindowObserver } from "../src/native-visuals.ts";

// LPT-850: Playwright attaches to a running Chrome or Edge only in YOLO, binds it to the addressed window, and the
// session's close detaches through the worker instead of leaving the browser to anyone else.
const window = { pid: 4100, window_id: 77, title: "Attach target - Personal - Microsoft Edge", app_name: "msedge.exe", bounds: { x: 0, y: 0, width: 800, height: 600 } };

function fixture(observer?: WindowObserver) {
  let mode: ComputerMode = "yolo";
  const call = vi.fn<Driver["call"]>(async (name): Promise<DriverResult> => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: [window] } };
    throw new Error(`Unexpected native call ${name}`);
  });
  const browser = { close: vi.fn(async () => {}), request: vi.fn(async () => ({})), page: vi.fn(async () => ({ url: "data:", title: "Attach target", snapshot: "- textbox \"Field\"", tabs: [], events: [] })) };
  const launch = vi.fn<WebLauncher>(async () => ({ browser: browser as unknown as WebBrowser,
    opened: { pid: window.pid, version: "155", url: "data:", title: "Attach target", via: "cdp" } }));
  const session = new ComputerSession({ call, identity: vi.fn(async () => `PiComputerUse.${"a".repeat(32)}:4100:1`), close: vi.fn(async () => {}) }, () => mode, undefined, observer, launch);
  const ref = async () => ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  return { session, launch, browser, call, ref, setMode(value: ComputerMode) { mode = value; } };
}

test("Playwright activity stays source-associated without exposing text or inventing a desktop point", async () => {
  const observer = vi.fn<WindowObserver>(async () => ({ status: "queued" })); const f = fixture(observer);
  const ref = await f.ref(); await f.session.attachBrowser(ref);
  const read = await f.session.observeDom(ref);
  expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ bounds: window.bounds, mark: { kind: "inspect" } });
  observer.mockClear();
  const result = await f.session.actDom(ref, read.details.observation_id!, { action: "fill", target: { ref: "e1" }, text: "synthetic-secret" });
  expect(result.details.status).toBe("delivered");
  expect(observer).toHaveBeenCalledTimes(1);
  expect(observer.mock.calls[0][0]).toMatchObject({ mark: { kind: "action" }, action: "fill", outcome: "delivered" });
  expect(observer.mock.calls[0][0]).not.toHaveProperty("mark.point");
  expect(observer.mock.calls[0][0]).not.toHaveProperty("mark.region");
  expect(JSON.stringify(observer.mock.calls)).not.toContain("synthetic-secret");
  await f.session.close();
});
test("browser crop presentation uses the final derived pixels returned to the agent", async () => {
  const observer = vi.fn<WindowObserver>(async () => ({ status: "queued" })); const f = fixture(observer);
  const ref = await f.ref(); await f.session.attachBrowser(ref);
  const png = await sharp({ create: { width: 6, height: 4, channels: 3, background: "blue" } }).png().toBuffer();
  f.browser.request.mockResolvedValue({ url: "data:", title: "Attach target", png: png.toString("base64"),
    derive: { geometry: { dpr: 1, scrollX: 0, scrollY: 0, innerWidth: 6, innerHeight: 4 }, box: { x: 2, y: 1, width: 2, height: 2 } } });
  const result = await f.session.webImage(ref, undefined, "crop", { ref: "e1" });
  expect(result.details.status).toBe("observed");
  const image = result.content.find(block => block.type === "image");
  expect(image?.type).toBe("image");
  const decoded = await sharp(Buffer.from(image!.data!, "base64")).raw().toBuffer({ resolveWithObject: true });
  expect(decoded.info).toMatchObject({ width: 2, height: 2, channels: 3 });
  expect([...decoded.data]).toEqual(Array.from({ length: 4 }, () => [0, 0, 255]).flat());
  expect(observer).toHaveBeenCalledTimes(1);
  expect(observer.mock.calls[0][0]).toMatchObject({ mark: { kind: "inspect" }, image });
  expect(observer.mock.calls[0][0]).not.toHaveProperty("mark.point");
  expect(observer.mock.calls[0][0]).not.toHaveProperty("mark.region");
  await f.session.close();
});
test("opening a browser selects the page window instead of an owned browser dialog", async () => {
  const f = fixture();
  f.call.mockImplementation(async name => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: [
      { ...window, window_id: 78, title: "Translate page?" }, window,
    ] } };
    throw new Error(`Unexpected native call ${name}`);
  });
  const opened = await f.session.openBrowser({ browser: "msedge", profile: "agent" });
  expect(opened.details.status).toBe("observed");
  expect(opened.details.target?.window_id).toBe(window.window_id);
  await f.session.close();
});
test("opening waits when the first visible window is only a browser dialog", async () => {
  const f = fixture();
  let reads = 0;
  f.call.mockImplementation(async name => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: ++reads === 1 ? [{ ...window, window_id: 78, title: "Translate page?" }] : [window] } };
    throw new Error(`Unexpected native call ${name}`);
  });
  const opened = await f.session.openBrowser({ browser: "msedge", profile: "agent" });
  expect(opened.details.target?.window_id).toBe(window.window_id);
  expect(reads).toBeGreaterThan(1);
  await f.session.close();
});
test("Safe mode only attaches to its own agent profile after approval", async () => {
  const f = fixture();
  f.setMode("safe");
  const opened = await f.session.openBrowser({ browser: "chrome", profile: "agent" });
  expect(opened.details.status).toBe("observed");
  expect(f.launch).toHaveBeenCalledWith({ browser: "chrome", profile: "agent", approval: true }, undefined);
  const ref = opened.details.window_ref!;
  expect((await f.session.observeDom(ref)).details.status).toBe("refused");
  expect((await f.session.attachBrowser(ref)).details.status).toBe("delivered");
  expect(f.browser.request).toHaveBeenCalledWith("approve", {}, undefined, expect.any(Number));
  expect((await f.session.observeDom(ref)).details.status).toBe("observed");
  await f.session.close();
  expect(f.browser.close).toHaveBeenCalledTimes(1);
});
test("a YOLO agent browser blocks Safe until it is closed", async () => {
  const f = fixture();
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(false);
  await f.session.openBrowser({ browser: "chrome", profile: "agent" });
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(true);
  await f.session.close();
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(false);
});

test("an in-flight YOLO agent launch blocks Safe and rejects a concurrent mode change", async () => {
  const f = fixture();
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  f.launch.mockImplementationOnce(async () => { await waiting; return { browser: f.browser as unknown as WebBrowser, opened: { pid: window.pid, version: "", url: "", title: "" } }; });
  const opening = f.session.openBrowser({ browser: "chrome", profile: "agent" });
  await vi.waitFor(() => expect(f.launch).toHaveBeenCalled());
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(true);
  f.setMode("safe");
  finish();
  expect((await opening).details.status).toBe("refused");
  expect(f.browser.close).toHaveBeenCalledOnce();
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(false);
  await f.session.close();
});
test("an uncertain YOLO launch remains unknown and blocks Safe", async () => {
  const f = fixture();
  f.launch.mockRejectedValueOnce(new WebError("cleanup unconfirmed", false, true));
  const opened = await f.session.openBrowser({ browser: "chrome", profile: "agent" });
  expect(opened.details.status).toBe("unknown");
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(true);
  expect((await f.session.close()).details.status).toBe("unknown");
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(true);
});

test("an approved connection reports uncertain deferred navigation without losing the attachment", async () => {
  const f = fixture();
  f.setMode("safe");
  const opened = await f.session.openBrowser({ browser: "chrome", profile: "agent", url: "https://example.invalid" });
  f.browser.request.mockResolvedValueOnce({ pid: window.pid, version: "155", url: "about:blank", title: "", via: "toggle", navigation_error: "connection reset" });
  const attached = await f.session.attachBrowser(opened.details.window_ref!);
  expect(attached.details.status).toBe("unknown");
  expect(attached.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("navigation outcome is unknown") });
  expect((await f.session.observeDom(opened.details.window_ref!)).details.status).toBe("observed");
  await f.session.close();
});
test("a cancelled approval reports an unknown outcome and cleanup", async () => {
  const f = fixture();
  f.setMode("safe");
  const opened = await f.session.openBrowser({ browser: "chrome", profile: "agent" });
  f.browser.request.mockRejectedValueOnce(new WebError("cancelled", false, true));
  const attached = await f.session.attachBrowser(opened.details.window_ref!);
  expect(attached.details.status).toBe("unknown");
  expect(attached.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("cleanup confirmed") });
  expect(f.browser.close).toHaveBeenCalledOnce();
  await f.session.close();
});
test("a mode change stops native input to a pending Safe browser during a sequence", async () => {
  const f = fixture();
  f.setMode("safe");
  const opened = await f.session.openBrowser({ browser: "msedge", profile: "agent" });
  f.setMode("yolo");
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "red" } }).png().toBuffer();
  const image = { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };
  let inputs = 0;
  f.call.mockImplementation(async name => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: [window] } };
    if (name === "get_window_state") return { content: [image], structuredContent: { pid: window.pid, window_id: window.window_id,
      window_bounds: window.bounds, screenshot_width: 40, screenshot_height: 30, elements: [] } };
    if (name === "press_key") { inputs++; f.setMode("safe"); return { content: [], structuredContent: { effect: "confirmed" } }; }
    throw new Error(`Unexpected native call ${name}`);
  });
  const ref = opened.details.window_ref!;
  const observed = await f.session.observe(ref);
  const result = await f.session.act({ window_ref: ref, observation_id: observed.details.observation_id!, action: "sequence",
    sequence: [{ action: "key", key: "a" }, { action: "key", key: "b" }] });
  expect(result.details.status).toBe("unknown");
  expect(inputs).toBe(1);
  await f.session.close();
});
test("pending browser input in flight blocks a switch to Safe", async () => {
  const f = fixture();
  f.setMode("safe");
  const opened = await f.session.openBrowser({ browser: "msedge", profile: "agent" });
  f.setMode("yolo");
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "red" } }).png().toBuffer();
  const image = { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.call.mockImplementation(async name => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: [window] } };
    if (name === "get_window_state") return { content: [image], structuredContent: { pid: window.pid, window_id: window.window_id,
      window_bounds: window.bounds, screenshot_width: 40, screenshot_height: 30, elements: [] } };
    if (name === "press_key") { await waiting; return { content: [], structuredContent: { effect: "confirmed" } }; }
    throw new Error(`Unexpected native call ${name}`);
  });
  const ref = opened.details.window_ref!;
  const observed = await f.session.observe(ref);
  const action = f.session.act({ window_ref: ref, observation_id: observed.details.observation_id!, action: "key", key: "a" });
  await vi.waitFor(() => expect(f.session.hasUnapprovedAgentBrowser()).toBe(true));
  release(); await action;
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(false);
  await f.session.close();
});
test("input to a sibling dialog blocks Safe until it completes", async () => {
  const f = fixture();
  f.setMode("safe"); await f.session.openBrowser({ browser: "msedge", profile: "agent" });
  f.setMode("yolo");
  const dialog = { ...window, window_id: 78, title: "Allow remote debugging?" };
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "red" } }).png().toBuffer();
  const image = { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.call.mockImplementation(async name => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: [window, dialog] } };
    if (name === "get_window_state") return { content: [image], structuredContent: { pid: dialog.pid, window_id: dialog.window_id,
      window_bounds: dialog.bounds, screenshot_width: 40, screenshot_height: 30, elements: [] } };
    if (name === "press_key") { await waiting; return { content: [], structuredContent: { effect: "confirmed" } }; }
    throw new Error(`Unexpected native call ${name}`);
  });
  const windows = await f.session.windows();
  const ref = (windows.details.state!.windows as { window_ref: string; window_id: number }[]).find(item => item.window_id === 78)!.window_ref;
  const observed = await f.session.observe(ref);
  const action = f.session.act({ window_ref: ref, observation_id: observed.details.observation_id!, action: "key", key: "a" });
  await vi.waitFor(() => expect(f.session.hasUnapprovedAgentBrowser()).toBe(true));
  release(); await action;
  expect(f.session.hasUnapprovedAgentBrowser()).toBe(false);
  await f.session.close();
});
test("Safe mode refuses before any Playwright work", async () => {
  const f = fixture();
  const ref = await f.ref();
  f.setMode("safe");
  const result = await f.session.attachBrowser(ref);
  expect(result.details.status).toBe("refused");
  expect(f.launch).not.toHaveBeenCalled();
});

test("a YOLO attach completing after Safe was selected is detached without publishing browser data", async () => {
  const f = fixture();
  const ref = await f.ref();
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  f.launch.mockImplementationOnce(async () => { await waiting; return { browser: f.browser as unknown as WebBrowser, opened: { pid: window.pid, version: "155", url: "https://private.invalid", title: "Private" } }; });
  const attaching = f.session.attachBrowser(ref);
  await vi.waitFor(() => expect(f.launch).toHaveBeenCalled());
  f.setMode("safe"); finish();
  const result = await attaching;
  expect(result.details.status).toBe("refused");
  expect(JSON.stringify(result)).not.toContain("private.invalid");
  expect(f.browser.close).toHaveBeenCalledOnce();
  await f.session.close();
});
test("an attached window serves DOM reads, refuses a second attach, and the session close detaches", async () => {
  const f = fixture();
  const ref = await f.ref();
  expect((await f.session.observeDom(ref)).details.status).toBe("refused");
  const attached = await f.session.attachBrowser(ref);
  expect(attached.details.status).toBe("delivered");
  // The worker receives the window's own process and title, which pick the visible tab.
  expect(f.launch).toHaveBeenCalledWith({ attach: { pid: window.pid, title: window.title } }, undefined);
  expect((await f.session.observeDom(ref)).details.status).toBe("observed");
  expect((await f.session.attachBrowser(ref)).details.status).toBe("refused");
  expect(f.launch).toHaveBeenCalledTimes(1);
  await f.session.close();
  expect(f.browser.close).toHaveBeenCalledTimes(1);
});
