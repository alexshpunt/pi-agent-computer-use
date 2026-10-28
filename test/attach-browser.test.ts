import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";
import type { WebBrowser, WebLauncher } from "../src/web-browser.ts";
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
  return { session, launch, browser, ref, setMode(value: ComputerMode) { mode = value; } };
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
test("Safe mode refuses before any Playwright work", async () => {
  const f = fixture();
  const ref = await f.ref();
  f.setMode("safe");
  const result = await f.session.attachBrowser(ref);
  expect(result.details.status).toBe("refused");
  expect(f.launch).not.toHaveBeenCalled();
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
