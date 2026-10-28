import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type ComputerMode, type Driver } from "../src/session.ts";
import type { WindowObserver } from "../src/native-visuals.ts";

async function fixture(observer: WindowObserver) {
  let mode: ComputerMode = "yolo"; let marker = 1;
  const bounds = { x: 30, y: 40, width: 1000, height: 700 };
  const windows = [{ pid: 42, window_id: 100, app_name: "Calculator.exe", title: "Outside", bounds }];
  const png = { type: "image" as const, mimeType: "image/png", data: (await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer()).toString("base64") };
  const raw = { type: "image" as const, mimeType: "image/png", data: (await sharp({ create: { width: 1000, height: 700, channels: 3, background: "white" } }).png().toBuffer()).toString("base64") };
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
      if (name === "get_window_state") return { content: [png], structuredContent: { ...args, elements: [{ element_token: "root", frame: { x: 30, y: 40, w: 1000, h: 700 }, screenshot_frame: { x: -1, y: -1, w: 500, h: 350 } }, { element_token: "button", frame: { x: 230, y: 240, w: 120, h: 60 }, screenshot_frame: { x: 100, y: 100, w: 60, h: 30 } }], screenshot_width: 500, screenshot_height: 350, window_bounds: bounds } };
      if (name === "zoom") return { content: [jpeg], structuredContent: { width: 200, height: 100 } };
      if (name === "get_desktop_state") return { content: [args.max_image_dimension === 0 ? raw : png], structuredContent: { display: "primary", platform: "windows", screenshot_width: args.max_image_dimension === 0 ? 1000 : 500, screenshot_height: args.max_image_dimension === 0 ? 700 : 350, screenshot_original_width: 1000, screenshot_original_height: 700, screen_width: 1000, screen_height: 700, scale_factor: 1 } };
      if (name === "click" && args.x !== undefined) return { content: [{ type: "text", text: "✅ Posted click to Chromium pid 42 at (231,241) (background, no foreground swap)." }], structuredContent: { path: "post_message", effect: "unverifiable" } };
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

test("overview, requested window zoom and primary-display crop flash their own physical scopes", async () => {
  const observer = vi.fn<WindowObserver>(async () => ({ status: "shown" })); const f = await fixture(observer);
  f.setMode("safe"); const opened = await f.session.open("Calculator");
  expect(opened.details).toMatchObject({ status: "observed", highlight: { status: "shown" } });
  expect(observer).toHaveBeenCalledWith({ target: { pid: 42, window_id: 101 }, identity: `PiComputerUse.${"a".repeat(32)}:42:1`, bounds: f.bounds, image: opened.content.find(block => block.type === "image") }, undefined);
  const overview = await f.session.observe(opened.details.window_ref!);
  const detail = await f.session.observe(opened.details.window_ref!, undefined, undefined, {
    image_id: overview.details.agent_image!.image_id as string, x: 10, y: 10, width: 100, height: 70,
  });
  expect(detail.details.status).toBe("observed"); expect(detail.content).toContainEqual(f.jpeg);
  expect(detail.details.highlight).toMatchObject({ kind: "detail", status: "shown", region: { x: 51, y: 61, width: 200, height: 140 } });
  expect(observer.mock.calls[1][0]).toHaveProperty("image", overview.content.find(block => block.type === "image"));
  expect(observer.mock.calls[2][0]).toHaveProperty("image", f.jpeg);
  expect(observer).toHaveBeenCalledTimes(3);
  expect(observer.mock.calls[2][0]).toMatchObject({ bounds: f.bounds, mark: { kind: "detail", region: { x: 51, y: 61, width: 200, height: 140 } } });
  f.setMode("yolo"); const display = await f.session.observeDisplay("primary");
  expect(observer.mock.calls[3][0]).toMatchObject({ display: "primary", bounds: { x: 0, y: 0, width: 1000, height: 700 } });
  await f.session.observeDisplay("primary", undefined, { image_id: display.details.agent_image!.image_id as string, x: 20, y: 30, width: 100, height: 80 });
  expect(observer.mock.calls[4][0]).toMatchObject({ display: "primary", mark: { kind: "detail", region: { x: 40, y: 60, width: 200, height: 160 } } });
});

test("action marks AX before input and the resolved pixel after dispatch; stale input never draws", async () => {
  const events: string[] = [];
  const observer = vi.fn<WindowObserver>(async () => { events.push("mark"); return { status: "shown" }; });
  const f = await fixture(observer); const ref = await outside(f.session);
  const original = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => { if (name === "click") events.push("input"); return original(name, args, signal); });
  const read = await f.session.observe(ref); observer.mockClear(); events.length = 0;
  const action = { window_ref: ref, observation_id: read.details.observation_id!, action: "click" as const, element_token: "button" };
  expect((await f.session.act(action)).details.status).toBe("delivered");
  expect(events).toEqual(["mark", "input", "mark"]);
  expect(observer.mock.calls[1][0]).toMatchObject({ outcome: "delivered" });
  expect(observer.mock.calls[0][0]).toMatchObject({ mark: { kind: "action", region: { x: 230, y: 240, width: 120, height: 60 } } });
  expect((await f.session.act(action)).details.status).toBe("refused"); expect(observer).toHaveBeenCalledTimes(2);
  const next = await f.session.observe(ref); observer.mockClear();
  await f.session.act({ ...action, observation_id: next.details.observation_id!, element_token: undefined, x: 100, y: 100 });
  expect(observer.mock.calls.at(-1)![0]).toMatchObject({ mark: { kind: "action", point: { x: 231, y: 241 } } });
});

test("an ungrounded keyboard action does not invent a focused element, and renderer failure never replays input", async () => {
  const observer = vi.fn<WindowObserver>(async () => { throw new Error("no helper"); });
  const f = await fixture(observer); const ref = await outside(f.session); const read = await f.session.observe(ref);
  observer.mockClear();
  const result = await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, action: "key", key: "return" });
  expect(result.details.status).toBe("delivered"); expect(result.details.highlight).toMatchObject({ status: "unavailable" });
  expect(result.details.highlight).toMatchObject({ reason: "renderer_unavailable" });
  expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ mark: { kind: "action" }, outcome: "delivered" });
  expect(observer.mock.calls.at(-1)?.[0]).not.toHaveProperty("mark.point");
  expect(observer.mock.calls.at(-1)?.[0]).not.toHaveProperty("mark.region");
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "press_key")).toHaveLength(1);
});
test("permission loss or cancellation during an action mark prevents the single native dispatch", async () => {
  const abort = new AbortController(); let active = false;
  const f = await fixture(async () => { if (active) abort.abort(); return { status: "shown" }; });
  const ref = await outside(f.session); const read = await f.session.observe(ref); active = true;
  expect((await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, action: "click", element_token: "button" }, abort.signal)).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "click")).toHaveLength(0);
});

test("a refused pixel dispatch cannot turn a plausible native coordinate into an action mark", async () => {
  const observer = vi.fn<WindowObserver>(async () => ({ status: "shown" })); const f = await fixture(observer);
  const ref = await outside(f.session); const read = await f.session.observe(ref); observer.mockClear();
  const original = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (name, args, signal) => name === "click" ? {
    content: [{ type: "text", text: "✅ Performed UIA Invoke at (231,241) for pid 42." }],
    structuredContent: { effect: "refused" },
  } : original(name, args, signal));
  const result = await f.session.act({ window_ref: ref, observation_id: read.details.observation_id!, action: "click", x: 100, y: 100 });
  expect(result.details.status).toBe("refused");
  expect(observer.mock.calls[0][0]).toEqual({ clear: true });
  expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ mark: { kind: "action" }, outcome: "refused" });
  expect(observer.mock.calls.at(-1)?.[0]).not.toHaveProperty("mark.point");
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "click")).toHaveLength(1);
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

test("snapshot refinement previews the final annotated image and verification emits one completion, not every sample", async () => {
  const observer = vi.fn<WindowObserver>(async () => ({ status: "queued" }));
  const f = await fixture(observer); const ref = await outside(f.session);
  const read = await f.session.observe(ref); observer.mockClear();
  const refined = await f.session.observe(ref, undefined, undefined, undefined, {
    observation_id: read.details.observation_id!, operation: "highlight", hint: read.details.ui!.elements[1].hint,
  });
  expect(refined.details.status).toBe("observed");
  expect(observer).toHaveBeenCalledTimes(1);
  expect(observer.mock.calls[0][0]).toMatchObject({ mark: { kind: "inspect", region: { x: 230, y: 240, width: 120, height: 60 } }, image: refined.content.find(block => block.type === "image") });
  observer.mockClear();
  const result = await f.session.waitFor(ref, f.session.waitSpec(ref, { action: "verify", conditions: [{ target: { role: "Button" }, is: "visible" }] }));
  expect(result.details.verification?.samples).toBe(1);
  expect(observer).toHaveBeenCalledTimes(1);
  expect(observer.mock.calls[0][0]).toMatchObject({ mark: { kind: "verify" } });
  expect(observer.mock.calls[0][0]).not.toHaveProperty("image");
});
test("renderer failure does not corrupt or replay a valid desktop capture", async () => {
  const observer = vi.fn<WindowObserver>(async () => { throw new Error("render failure"); }); const f = await fixture(observer);
  const read = await f.session.observe(await outside(f.session), undefined, undefined, undefined, undefined, { hints: false });
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
