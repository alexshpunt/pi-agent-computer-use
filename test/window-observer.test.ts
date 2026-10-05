import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type ComputerMode, type Driver } from "../src/session.ts";
import type { WindowObserver } from "../src/window-overlay.ts";

async function fixture(observer: WindowObserver) {
  let mode: ComputerMode = "yolo"; let marker = 1;
  const bounds = { x: 30, y: 40, width: 1000, height: 700 };
  const windows = [{ pid: 42, window_id: 100, app_name: "Calculator.exe", title: "Outside", bounds }];
  const png = { type: "image" as const, mimeType: "image/png", data: (await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer()).toString("base64") };
  const jpeg = { type: "image" as const, mimeType: "image/jpeg", data: (await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } }).jpeg().toBuffer()).toString("base64") };
  const driver: Driver = {
    identity: vi.fn(async () => `PiComputerUse.${"a".repeat(32)}:42:${marker}`), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Calculator", launch_path: "calculator.exe" }] } };
      if (name === "launch_app") {
        const created = { pid: 42, window_id: 101, app_name: "Calculator.exe", title: "Owned", bounds };
        windows.push(created); return { content: [], structuredContent: { pid: 42, windows: [created] } };
      }
      if (name === "get_window_state") return { content: [png], structuredContent: { ...args, elements: [], screenshot_width: 500, screenshot_height: 350, window_bounds: bounds } };
      if (name === "zoom") return { content: [jpeg], structuredContent: { width: 200, height: 100 } };
      if (name === "get_desktop_state") return { content: [png], structuredContent: { display: "primary", platform: "windows", screenshot_width: 500, screenshot_height: 350 } };
      return { content: [], structuredContent: {} };
    }),
  };
  const session = new ComputerSession(driver, () => mode, undefined, observer);
  return { session, driver, bounds, png, jpeg, setMode: (value: ComputerMode) => { mode = value; }, recycle: () => { marker++; } };
}

async function outside(session: ComputerSession) {
  const listed = await session.windows();
  return (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
}

test("desktop open, overview and detail flash only the whole successfully observed source", async () => {
  const observer = vi.fn<WindowObserver>(async () => ({ status: "shown" })); const f = await fixture(observer);
  f.setMode("safe"); const opened = await f.session.open("Calculator");
  expect(opened.details).toMatchObject({ status: "observed", highlight: { status: "shown" } });
  expect(observer).toHaveBeenCalledWith({ target: { pid: 42, window_id: 101 }, identity: `PiComputerUse.${"a".repeat(32)}:42:1`, bounds: f.bounds }, undefined);
  const overview = await f.session.observe(opened.details.window_ref!);
  const detail = await f.session.observe(opened.details.window_ref!, undefined, undefined, {
    image_id: overview.details.agent_image!.image_id as string, x: 10, y: 10, width: 100, height: 70,
  });
  expect(detail.details.status).toBe("observed"); expect(detail.content).toContainEqual(f.jpeg);
  expect(observer).toHaveBeenCalledTimes(3);
  expect(observer.mock.calls[2][0].bounds).toEqual(f.bounds);
  f.setMode("yolo"); await f.session.observeDisplay("primary"); expect(observer).toHaveBeenCalledTimes(3);
});

test("Safe denial, pre-cancellation and recycled HWNDs never reach the frame observer", async () => {
  const observer = vi.fn<WindowObserver>(async () => ({ status: "shown" })); const f = await fixture(observer);
  const ref = await outside(f.session); f.setMode("safe");
  expect((await f.session.observe(ref)).details.status).toBe("refused");
  f.setMode("yolo"); const abort = new AbortController(); abort.abort();
  expect((await f.session.observe(ref, abort.signal)).details.status).toBe("refused");
  f.recycle(); expect((await f.session.observe(ref)).details.status).toBe("refused");
  expect(observer).not.toHaveBeenCalled();
});

test("renderer failure does not corrupt or replay a valid desktop capture", async () => {
  const observer = vi.fn<WindowObserver>(async () => { throw new Error("render failure"); }); const f = await fixture(observer);
  const read = await f.session.observe(await outside(f.session));
  expect(read.details).toMatchObject({ status: "observed", highlight: { status: "unavailable" } });
  expect(read.content).toContainEqual(f.png);
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "get_window_state")).toHaveLength(1);
});

test("permission revoked while the helper starts withholds the completed window image", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async () => { f.setMode("safe"); return { status: "skipped" }; });
  const read = await f.session.observe(await outside(f.session));
  expect(read.details.status).toBe("refused"); expect(read.content.every(block => block.type === "text")).toBe(true);
});
