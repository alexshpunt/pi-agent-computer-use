import sharp from "sharp";
import { McpDriver } from "../src/driver.ts";
import { expect, test, vi } from "vitest";
import { ComputerSession, type Action, type Driver } from "../src/session.ts";

test("existing runtimes refuse native pointer dispatch before starting any peer", async () => {
  for (const runtime of [undefined, "windows-persistent-wgc"] as const) {
    const driver = new McpDriver({ command: "/not-a-native-driver", runtime });
    try {
      expect(await driver.call("move_pointer", { pid: 42, window_id: 91, element_token: "current", delivery_mode: "foreground", dwell_ms: 0 }))
        .toMatchObject({ isError: true, structuredContent: { status: "refused", code: "native_pointer_unavailable", attempted: false, delivered: false } });
    } finally { await driver.close(); }
  }
});
const receipt = (dwell = 0) => ({ attempted: true, delivered: true, route: "native", effect: "unverifiable",
  delivery_mode: "foreground", dwell_ms: dwell, dwell_elapsed_ms: dwell,
  foreground_changed: true, pointer_changed: true, foreground_at_target: true, pointer_at_target: true });
async function fixture() {
  let mode: "safe" | "yolo" = "yolo", alive = true, geometry = true, capture = true;
  const image = await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer();
  const driver: Driver = {
    identity: vi.fn(async () => alive ? "original" : undefined), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }, { pid: 42, window_id: 92 }] } };
      if (name === "get_window_state") return { content: args.include_screenshot === false ? [] : [{ type: "image", mimeType: "image/png", data: image.toString("base64") }],
        structuredContent: { window_bounds: { x: 10, y: 20, width: 1000, height: 700 }, screenshot_width: 500, screenshot_height: 350,
          ...(capture ? { capture_id: "overview-capture" } : {}), elements: [{ element_token: "control", role: "Button", label: "Synthetic hover control",
            ...(geometry ? { frame: { x: 30, y: 40, w: 100, h: 80 } } : {}) }] } };
      return { content: [], structuredContent: receipt(Number(args.dwell_ms)) };
    }),
  };
  Object.assign(driver, { nativePointer: true });
  const session = new ComputerSession(driver, () => mode);
  const windows = (await session.windows()).details.state!.windows as { window_ref: string }[];
  const observe = (ui = false) => session.observe(windows[0].window_ref, undefined, undefined, undefined, undefined, ui ? { granularity: "ui" } : undefined);
  const view = await observe();
  const base = { window_ref: windows[0].window_ref, observation_id: view.details.observation_id! };
  const send = (command: Record<string, unknown>, signal?: AbortSignal) => session.act({ ...base, ...command } as Action, signal);
  const inputs = () => vi.mocked(driver.call).mock.calls.filter(([name]) => !["list_windows", "get_window_state"].includes(name));
  return { driver, session, base, send, inputs, observe, other: windows[1].window_ref,
    safe: () => { mode = "safe"; }, retire: () => { alive = false; }, noGeometry: () => { geometry = false; }, noCapture: () => { capture = false; } };
}

test.each([{ action: "move", dwell: 0 }, { action: "hover", dwell: 250 }])("$action sends one capture-bound native movement without buttons or keys", async ({ action, dwell }) => {
  const f = await fixture();
  const command = { action, x: 100, y: 80, delivery_mode: "foreground", ...(action === "hover" ? { dwell_ms: dwell } : {}) };
  const result = await f.send(command);
  expect(result.details.status).toBe("delivered");
  expect(f.inputs()).toEqual([["move_pointer", { pid: 42, window_id: 91, capture_id: "overview-capture", x: 100, y: 80, dwell_ms: dwell, delivery_mode: "foreground" }, undefined]]);
  expect(result.details.action_capability).toMatchObject({ actual_delivery: "foreground", foreground: "delivered", route: "native" });
  expect(result.details.state).toMatchObject({ effect: "unverifiable", foreground_changed: true, pointer_changed: true });
  expect((await f.send(command)).details.status).toBe("refused"); expect(f.inputs()).toHaveLength(1);
});

test("a UI-only hint uses its proven native token without inventing a pixel capture", async () => {
  const f = await fixture(); const view = await f.observe(true);
  const result = await f.send({ observation_id: view.details.observation_id, action: "hover", dwell_ms: 100,
    delivery_mode: "foreground", hint: view.details.ui!.elements[0].hint });
  expect(result.details.status).toBe("delivered");
  expect(f.inputs()).toEqual([["move_pointer", { pid: 42, window_id: 91, element_token: "control", dwell_ms: 100, delivery_mode: "foreground" }, undefined]]);
});

test.each([
  { action: "hover", x: 10, y: 10 }, { action: "hover", x: 10, y: 10, dwell_ms: 0 },
  { action: "hover", x: 10, y: 10, dwell_ms: 10001 }, { action: "hover", x: 10, y: 10, dwell_ms: 1.5 },
  { action: "move", x: 10, y: 10, dwell_ms: 0 }, { action: "move" },
  { action: "move", x: 500, y: 10 }, { action: "move", x: NaN, y: 10 },
  { action: "move", x: 10, y: 10, element_token: "control" },
  { action: "move", x: 10, y: 10, button: "left" }, { action: "move", x: 10, y: 10, modifiers: [] },
  { action: "move", x: 10, y: 10, animation: "reactive" },
  { action: "sequence", sequence: [{ action: "key", key: "a" }, { action: "move", x: 10, y: 10 }] },
])("unsupported pointer command cannot send any batch input: %j", async command => {
  const f = await fixture();
  expect((await f.send(command)).details.status).toBe("refused"); expect(f.inputs()).toHaveLength(0);
});

test.each(["unqualified", "geometry", "capture", "safe", "closed", "stale", "wrong", "cancel"])("pointer admission protects %s before native movement", async condition => {
  const f = await fixture(); let command: Record<string, unknown> = { action: "move", x: 100, y: 80 };
  if (condition === "unqualified") Object.assign(f.driver, { nativePointer: false });
  if (condition === "geometry") { f.noGeometry(); const view = await f.observe(true); command = { action: "move", element_token: "control", observation_id: view.details.observation_id }; }
  if (condition === "capture") { f.noCapture(); const view = await f.observe(); command.observation_id = view.details.observation_id; }
  if (condition === "safe") f.safe();
  if (condition === "closed") f.retire();
  if (condition === "stale") await f.observe();
  if (condition === "wrong") command.window_ref = f.other;
  expect((await f.send(command, condition === "cancel" ? AbortSignal.abort() : undefined)).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0);
});

test.each([
  { state: { status: "refused", code: "background_unavailable", attempted: false, delivered: false, escalation: { recommended: "foreground" } }, status: "refused" },
  { state: { status: "unknown", code: "pointer_moved", attempted: true, delivered: true, dwell_elapsed_ms: 30 }, status: "unknown" },
  { state: receipt(100), status: "delivered" },
  { state: { ...receipt(100), delivered: false }, status: "unknown" },
  { state: { ...receipt(100), dwell_elapsed_ms: 99 }, status: "unknown" },
  { state: { ...receipt(0) }, status: "unknown" },
  { state: { ...receipt(100), delivery_mode: "background" }, status: "unknown" },
  { state: { ...receipt(100), route: "overlay" }, status: "unknown" },
  { state: { effect: "unverifiable" }, status: "unknown" },
])("native prefix or malformed completion stays $status and never replays", async ({ state, status }) => {
  const f = await fixture(); const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => name === "move_pointer" ? { content: [], structuredContent: state } : call(name, args, signal));
  const command = { action: "hover", x: 100, y: 80, dwell_ms: 100, delivery_mode: "foreground" };
  expect((await f.send(command)).details.status).toBe(status);
  expect((await f.send(command)).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "move_pointer")).toHaveLength(1);
});

test("cancellation during dwell withholds completion and does not repeat motion", async () => {
  const f = await fixture(); const call = f.driver.call; const abort = new AbortController();
  f.driver.call = vi.fn(async (name, args, signal) => { const result = await call(name, args, signal); if (name === "move_pointer") abort.abort(); return result; });
  const command = { action: "hover", dwell_ms: 100, element_token: "control", delivery_mode: "foreground" };
  expect((await f.send(command, abort.signal)).details.status).toBe("unknown");
  expect((await f.send(command)).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "move_pointer")).toHaveLength(1);
});
