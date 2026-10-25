import sharp from "sharp";
import { expect, test, vi } from "vitest";
import { ComputerSession, type Action, type Driver } from "../src/session.ts";
import { McpDriver } from "../src/driver.ts";

test("older runtimes refuse coordinate wheel input before starting a native peer", async () => {
  for (const runtime of [undefined, "windows-persistent-wgc", "windows-native-pointer"] as const) {
    const driver = new McpDriver({ command: "/not-a-native-driver", runtime });
    try {
      expect(await driver.call("scroll_at", { pid: 42, window_id: 91, capture_id: "current",
        x: 10, y: 20, delta_x: 1, delta_y: 1, unit: "wheel_detents", delivery_mode: "foreground" }))
        .toMatchObject({ isError: true, structuredContent: { status: "refused", code: "coordinate_scroll_unavailable",
          attempted: false, delivered: false, pointer_attempted: false, pointer_delivered: false,
          attempted_axes: [], delivered_axes: [], fallback: false } });
    } finally { await driver.close(); }
  }
});

const receipt = (delta_x = 0, delta_y = 1) => {
  const axes = [...(delta_y ? ["y"] : []), ...(delta_x ? ["x"] : [])];
  return { attempted: true, delivered: true, pointer_attempted: true, pointer_delivered: true,
    delta_x, delta_y, unit: "wheel_detents", attempted_axes: axes, delivered_axes: axes,
    route: "native", effect: "unverifiable", delivery_mode: "foreground",
    foreground_changed: true, pointer_changed: true, foreground_at_target: true, pointer_at_target: true };
};
async function fixture() {
  let mode: "safe" | "yolo" = "yolo", identity: string | undefined = "original", capture = true;
  const image = await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer();
  const base: Driver = {
    identity: vi.fn(async () => identity), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }, { pid: 42, window_id: 92 }] } };
      if (name === "get_window_state") return { content: args.include_screenshot === false ? [] : [{ type: "image", mimeType: "image/png", data: image.toString("base64") }],
        structuredContent: { window_bounds: { x: 10, y: 20, width: 1000, height: 700 }, screenshot_width: 500, screenshot_height: 350,
          ...(capture ? { capture_id: "overview-capture" } : {}), elements: [{ element_token: "control", role: "Pane", label: "Synthetic scroll panel",
            frame: { x: 30, y: 40, w: 100, h: 80 } }] } };
      if (name === "scroll_at") return { content: [], structuredContent: receipt(Number(args.delta_x), Number(args.delta_y)) };
      return { content: [], structuredContent: { effect: "unverifiable", delivery: { mode: "background" } } };
    }),
  };
  Object.assign(base, { coordinateScroll: true });
  const driver = base;
  const session = new ComputerSession(driver, () => mode);
  const windows = (await session.windows()).details.state!.windows as { window_ref: string }[];
  const observe = (ui = false) => session.observe(windows[0].window_ref, undefined, undefined, undefined, undefined, ui ? { granularity: "ui" } : undefined);
  const view = await observe();
  const addressed = { window_ref: windows[0].window_ref, observation_id: view.details.observation_id! };
  const send = (command: Record<string, unknown>, signal?: AbortSignal) => session.act({ ...addressed, ...command } as Action, signal);
  const inputs = () => vi.mocked(base.call).mock.calls.filter(([name]) => !["list_windows", "get_window_state"].includes(name));
  return { base, driver, session, addressed, send, inputs, observe, other: windows[1].window_ref,
    safe: () => { mode = "safe"; }, retire: () => { identity = undefined; }, reuse: () => { identity = "replacement"; }, noCapture: () => { capture = false; } };
}
const point = { action: "scroll", x: 100, y: 80, unit: "wheel_detents" };

test.each([{ delta_y: 2 }, { delta_x: -3 }, { delta_x: 50, delta_y: -50 }])("coordinate scroll forwards exact overview pixels and integer detents: %j", async deltas => {
  const f = await fixture();
  const command = { ...point, ...deltas, delivery_mode: "foreground" };
  const result = await f.send(command);
  expect(result.details.status).toBe("delivered");
  expect(f.inputs()).toEqual([["scroll_at", { pid: 42, window_id: 91, capture_id: "overview-capture", x: 100, y: 80,
    delta_x: deltas.delta_x ?? 0, delta_y: deltas.delta_y ?? 0, unit: "wheel_detents", delivery_mode: "foreground" }, undefined]]);
  expect(result.details.action_capability).toMatchObject({ actual_delivery: "foreground", foreground: "delivered", route: "native" });
  expect(result.details.state).toMatchObject({ unit: "wheel_detents", effect: "unverifiable" });
  expect((await f.send(command)).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(1);
});

test("existing token-based line scroll keeps its native route", async () => {
  const f = await fixture();
  expect((await f.send({ action: "scroll", element_token: "control", direction: "down", by: "line", amount: 3 })).details.status).toBe("delivered");
  expect(f.inputs()).toEqual([["scroll", { target: { kind: "window", pid: 42, window_id: 91 }, element_token: "control", direction: "down", by: "line", amount: 3, delivery_mode: "background" }, undefined]]);
});

test.each([
  { delta_y: 0 }, { delta_y: 51 }, { delta_x: -51 }, { delta_y: 0.5 }, { delta_y: NaN }, { delta_y: Infinity },
  { delta_y: "1" }, { delta_y: null }, { delta_y: 1, unit: "pixels" }, { delta_y: 1, unit: undefined },
  { delta_y: 1, x: 500 }, { delta_y: 1, y: -1 }, { delta_y: 1, y: undefined },
  { delta_y: 1, element_token: "control" }, { delta_y: 1, hint: "h1" },
  { delta_y: 1, direction: "down" }, { delta_y: 1, amount: 2 }, { delta_y: 1, by: "line" },
  { delta_y: 1, modifiers: [] }, { delta_y: 1, animation: "reactive" }, { delta_y: 1, button: "left" },
])("invalid or mixed coordinate scroll sends no native input: %j", async fields => {
  const f = await fixture();
  expect((await f.send({ ...point, ...fields })).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0);
});

test("detent fields cannot turn a token scroll into a coordinate action", async () => {
  const f = await fixture();
  expect((await f.send({ action: "scroll", element_token: "control", direction: "down", delta_y: 1, unit: "wheel_detents" })).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0);
});

test("a nullable native effect sample stays unavailable without hiding delivery", async () => {
  const f = await fixture(); const call = f.base.call;
  f.base.call = vi.fn(async (name, args, signal) => name === "scroll_at" ? { content: [], structuredContent: {
    ...receipt(0, 1), foreground_changed: null, pointer_changed: null, foreground_at_target: null, pointer_at_target: null,
  } } : call(name, args, signal));
  expect((await f.send({ ...point, delta_y: 1, delivery_mode: "foreground" })).details.status).toBe("delivered");
  expect(f.inputs()).toHaveLength(1);
});
test("a coordinate scroll cannot join a keyboard batch", async () => {
  const f = await fixture();
  expect((await f.send({ action: "sequence", sequence: [{ action: "key", key: "a" }, { ...point, delta_y: 1 }] })).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0);
});

test.each(["unqualified", "capture", "ui", "safe", "closed", "reused", "stale", "wrong", "cancel"])("coordinate admission protects %s before wheel input", async condition => {
  const f = await fixture(); const command: Record<string, unknown> = { ...point, delta_y: 1, delivery_mode: "foreground" };
  if (condition === "unqualified") Object.assign(f.base, { coordinateScroll: false });
  if (condition === "capture") { f.noCapture(); command.observation_id = (await f.observe()).details.observation_id; }
  if (condition === "ui") command.observation_id = (await f.observe(true)).details.observation_id;
  if (condition === "safe") f.safe();
  if (condition === "closed") f.retire();
  if (condition === "reused") f.reuse();
  if (condition === "stale") await f.observe();
  if (condition === "wrong") command.window_ref = f.other;
  expect((await f.send(command, condition === "cancel" ? AbortSignal.abort() : undefined)).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0);
});

test.each([
  { state: receipt(2, 1), status: "delivered" },
  { state: { ...receipt(2, 1), pointer_delivered: false }, status: "unknown" },
  { state: { ...receipt(2, 1), attempted: false }, status: "unknown" },
  { state: { ...receipt(2, 1), delivered: false }, status: "unknown" },
  { state: { ...receipt(2, 1), unit: "pixels" }, status: "unknown" },
  { state: { ...receipt(2, 1), delta_x: 3 }, status: "unknown" },
  { state: { ...receipt(2, 1), attempted_axes: ["x", "y"] }, status: "unknown" },
  { state: { ...receipt(2, 1), delivered_axes: ["y"] }, status: "unknown" },
  { state: { ...receipt(2, 1), delivered_axes: ["y", "x", "x"] }, status: "unknown" },
  { state: { ...receipt(2, 1), delivery_mode: "background" }, status: "unknown" },
  { state: { ...receipt(2, 1), route: "posted" }, status: "unknown" },
  { state: { ...receipt(2, 1), effect: "verified" }, status: "unknown" },
  { state: { ...receipt(2, 1), pointer_changed: undefined }, status: "unknown" },
  { state: { ...receipt(2, 1), foreground_at_target: "yes" }, status: "unknown" },
  { state: { status: "refused", code: "background_unavailable", attempted: false, delivered: false, delivery: { mode: "background" }, escalation: { recommended: "foreground" } }, status: "refused" },
  { state: { ...receipt(2, 1), status: "unknown", code: "foreground_lost" }, status: "unknown" },
  { state: { ...receipt(2, 1), status: "unknown", code: "cancelled", attempted_axes: ["y"], delivered_axes: ["y"] }, status: "unknown" },
])("native scroll prefix or malformed completion stays $status with no replay", async ({ state, status }) => {
  const f = await fixture(); const call = f.base.call;
  f.base.call = vi.fn(async (name, args, signal) => name === "scroll_at" ? { content: [], structuredContent: state } : call(name, args, signal));
  const command = { ...point, delta_x: 2, delta_y: 1, delivery_mode: "foreground" };
  expect((await f.send(command)).details.status).toBe(status);
  expect((await f.send(command)).details.status).toBe("refused");
  expect(vi.mocked(f.base.call).mock.calls.filter(([name]) => name === "scroll_at")).toHaveLength(1);
});

test("a foreground-shaped success cannot certify a background coordinate request", async () => {
  const f = await fixture();
  expect((await f.send({ ...point, delta_y: 1 })).details.status).toBe("unknown");
  expect(f.inputs()).toHaveLength(1);
});

test("cancellation after native scroll withholds completion and never replays", async () => {
  const f = await fixture(); const call = f.base.call; const abort = new AbortController();
  f.base.call = vi.fn(async (name, args, signal) => { const result = await call(name, args, signal); if (name === "scroll_at") abort.abort(); return result; });
  const command = { ...point, delta_y: 1, delivery_mode: "foreground" };
  expect((await f.send(command, abort.signal)).details.status).toBe("unknown");
  expect((await f.send(command)).details.status).toBe("refused");
  expect(vi.mocked(f.base.call).mock.calls.filter(([name]) => name === "scroll_at")).toHaveLength(1);
});
