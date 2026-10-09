import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type Driver, type Content } from "../src/session.ts";
import type { UiCaptureOptions } from "../src/ui-resources.ts";
import { ReactiveAnimationDriver } from "../src/reactive-animation.ts";

const options = (granularity: string, extra = {}) => ({ granularity, ...extra }) as UiCaptureOptions;
async function fixture(persistentWgc = false, captureBackend: unknown = { backend: "wgc", resources_reused: true, paint_freshness: "unverified" }) {
  const data = await sharp({ create: { width: 500, height: 320, channels: 3, background: "white" } }).png().toBuffer();
  const image: Content = { type: "image", mimeType: "image/png", data: data.toString("base64") };
  let serial = 0; let mode: "safe" | "yolo" = "yolo"; let alive = true;
  const driver: Driver = {
    identity: vi.fn(async () => alive ? "same-window" : undefined), close: vi.fn(async () => {}),
    persistentWgc,
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }, { pid: 42, window_id: 92 }] } };
      if (name === "get_window_state") {
        const id = ++serial;
        const pixels = args.include_screenshot !== false;
        return { content: pixels ? [image] : [], structuredContent: {
          pid: 42, window_id: args.window_id, window_bounds: { x: 80, y: 90, width: 1000, height: 640 },
          ...(pixels ? { screenshot_width: 500, screenshot_height: 320, capture_id: `capture-${id}` } : {}),
          ...(args.capture_backend === "wgc" ? { capture_backend: captureBackend } : {}),
          ...(args.include_accessibility_tree !== false ? { snapshot_id: `s${id}`, elements_complete: true,
            elements: [{ element_index: 0, element_token: `s${id}:0`, role: "Button", label: "Save", enabled: true,
              actions: ["invoke"], frame: { x: 180, y: 190, w: 100, h: 40 }, screenshot_frame: { x: 50, y: 50, w: 50, h: 20 } }] } : {})
        } };
      }
      return { content: [], structuredContent: { effect: "confirmed", verified: true } };
    })
  };
  const session = new ComputerSession(persistentWgc ? new ReactiveAnimationDriver(driver, { glide_duration_ms: 1 }) : driver, () => mode);
  const windows = (await session.windows()).details.state!.windows as { window_ref: string }[];
  const ref = windows[0].window_ref;
  const observe = (granularity?: string, extra = {}, query?: string) => session.observe(ref, undefined, query, undefined, undefined,
    granularity ? options(granularity, extra) : undefined);
  return { session, driver, ref, other: windows[1].window_ref, observe, setMode: () => { mode = "safe"; }, retire: () => { alive = false; } };
}
function inputs(driver: Driver) { return vi.mocked(driver.call).mock.calls.filter(([name]) => ["click", "drag", "press_key"].includes(name)); }

test("full stays the default and returns current UI and pixels", async () => {
  const f = await fixture(); const read = await f.observe();
  expect(read.details.status).toBe("observed");
  expect(read.details).toMatchObject({ granularity: "full", captured: { image: true, ui: true } });
  expect(read.details.ui!.elements[0].name).toBe("Save");
  expect(read.content.filter(b => b.type === "image")).toHaveLength(1);
  expect(vi.mocked(f.driver.call).mock.calls.find(([name]) => name === "get_window_state")![1].include_accessibility_tree).not.toBe(false);
});

test("image-only skips the walk, retires old hints and grounds one pixel action", async () => {
  const f = await fixture(); const full = await f.observe(); const oldHint = full.details.ui!.elements[0].hint;
  const image = await f.observe("image");
  expect(image.details.status).toBe("observed");
  expect(image.details).toMatchObject({ granularity: "image", captured: { image: true, ui: false } });
  expect(image.details.ui).toBeUndefined();
  expect(image.details.state!.elements).toBeUndefined();
  expect(image.details.source!.semantic_scope).toBe("none");
  const other = await f.session.observe(f.other, undefined, undefined, undefined, undefined, options("image"));
  expect((await f.session.act({ window_ref: f.ref, observation_id: other.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("refused");
  const native = vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "get_window_state").at(-1)!;
  expect(native[1].include_accessibility_tree).toBe(false);
  expect(native[1]).not.toHaveProperty("max_elements");
  expect((await f.session.act({ window_ref: f.ref, observation_id: image.details.observation_id!, action: "click", hint: oldHint })).details.status).toBe("refused");
  expect(inputs(f.driver)).toHaveLength(0);
  expect((await f.session.act({ window_ref: f.ref, observation_id: image.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("delivered");
  expect((await f.session.act({ window_ref: f.ref, observation_id: image.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("refused");
  expect(inputs(f.driver)).toHaveLength(1);
});

test("UI-only returns no pixels or old image geometry and permits current hints", async () => {
  const f = await fixture(); const first = await f.observe(); const ui = await f.observe("ui");
  expect(ui.details.status).toBe("observed");
  expect(ui.details).toMatchObject({ granularity: "ui", captured: { image: false, ui: true } });
  expect(ui.content.some(b => b.type === "image")).toBe(false);
  expect(ui.details.agent_image).toBeUndefined();
  expect(ui.details.source!.capabilities.detail).toBe("unsupported");
  expect(ui.details.source!.image.dimensions).toEqual({ width: null, height: null });
  expect(ui.details.ui!.elements[0].bounds.window_image).toBeUndefined();
  expect(ui.details.ui!.elements[0].hint_display).toBe("off");
  const inspect = await f.session.observe(f.ref, undefined, undefined, undefined,
    { operation: "inspect", observation_id: ui.details.observation_id!, hint: ui.details.ui!.elements[0].hint });
  expect(inspect.details.ui!.elements[0].name).toBe("Save");
  expect(inspect.content.some(b => b.type === "image")).toBe(false);
  for (const operation of ["highlight", "scope", "crop"] as const) {
    expect((await f.session.observe(f.ref, undefined, undefined, undefined,
      { operation, observation_id: ui.details.observation_id!, hint: ui.details.ui!.elements[0].hint })).details.status).toBe("refused");
  }
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "get_window_state").at(-1)![1].include_screenshot).toBe(false);
  expect((await f.session.act({ window_ref: f.ref, observation_id: first.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("refused");
  expect((await f.session.act({ window_ref: f.ref, observation_id: ui.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("refused");
  expect((await f.session.observe(f.ref, undefined, undefined, { image_id: first.details.agent_image!.image_id as string, x: 30, y: 30, width: 50, height: 50 })).details.status).toBe("refused");
  expect(inputs(f.driver)).toHaveLength(0);
  expect((await f.session.act({ window_ref: f.ref, observation_id: ui.details.observation_id!, action: "click", hint: ui.details.ui!.elements[0].hint })).details.status).toBe("delivered");
  expect(inputs(f.driver)).toHaveLength(1);
});

test("invalid modes and incompatible controls do not take a native snapshot", async () => {
  const f = await fixture();
  for (const [mode, extra, query] of [["bad", {}, undefined], ["image", { max_elements: 10 }, undefined],
    ["image", { hints: true }, undefined], ["image", {}, "Save"], ["ui", { guides: { grid: true, region: false, action: false } }, undefined]] as const) {
    expect((await f.observe(mode, extra, query)).details.status).toBe("refused");
  }
  expect(vi.mocked(f.driver.call).mock.calls.some(([name]) => name === "get_window_state")).toBe(false);
});

test.each([false, true])("mode selection does not bypass Safe, lifetime or cancellation (WGC=%s)", async wgc => {
  const extra = wgc ? { backend: "wgc" } : {};
  const f = await fixture(wgc); f.setMode();
  expect((await f.observe("image", extra)).details.status).toBe("refused");
  expect((await f.observe("ui")).details.status).toBe("refused");
  const g = await fixture(wgc); const v = await g.observe("image", extra); g.retire();
  expect((await g.session.act({ window_ref: g.ref, observation_id: v.details.observation_id!, action: "click", x: 1, y: 1 })).details.status).toBe("refused");
  expect(inputs(g.driver)).toHaveLength(0);
  const h = await fixture(wgc); const aborted = AbortSignal.abort();
  expect((await h.session.observe(h.ref, aborted, undefined, undefined, undefined, options("image", extra))).details.status).toBe("refused");
  expect(vi.mocked(h.driver.call).mock.calls.some(([name]) => name === "get_window_state")).toBe(false);
});

test("explicit WGC projects only on qualified image/full reads and grounds a single pixel action", async () => {
  const f = await fixture(true);
  expect((await f.observe("full", { backend: "default" })).details.status).toBe("observed");
  const first = vi.mocked(f.driver.call).mock.calls.find(([name]) => name === "get_window_state")!;
  expect(first[1]).not.toHaveProperty("capture_backend");
  for (const mode of ["image", "full"]) {
    const read = await f.observe(mode, { backend: "wgc" });
    expect(read.details.status).toBe("observed");
    expect(read.details.state!.capture_backend).toMatchObject({ backend: "wgc", resources_reused: true, paint_freshness: "unverified" });
    expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "get_window_state").at(-1)![1].capture_backend).toBe("wgc");
    expect((await f.session.act({ window_ref: f.ref, observation_id: read.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("delivered");
    expect((await f.session.act({ window_ref: f.ref, observation_id: read.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("refused");
  }
  expect(inputs(f.driver)).toHaveLength(2);
});

test("unsupported or invalid capture selection does not capture or retire valid input", async () => {
  const f = await fixture();
  const first = await f.observe("image");
  for (const [mode, backend] of [["image", "wgc"], ["image", "bad"], ["ui", "wgc"]]) {
    expect((await f.observe(mode, { backend })).details.status).toBe("refused");
  }
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "get_window_state")).toHaveLength(1);
  expect((await f.session.act({ window_ref: f.ref, observation_id: first.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("delivered");
  const g = await fixture(true);
  expect((await g.observe("ui", { backend: "wgc" })).details.status).toBe("refused");
  expect(vi.mocked(g.driver.call).mock.calls.some(([name]) => name === "get_window_state")).toBe(false);
});

test("explicit WGC never admits substituted default pixels or reuses the previous observation", async () => {
  for (const metadata of [null, { backend: "default" }]) {
    const f = await fixture(true, metadata);
    const prior = await f.observe("image");
    const read = await f.observe("image", { backend: "wgc" });
    expect(read.details.status).toBe("refused");
    expect(read.content.some(block => block.type === "image")).toBe(false);
    expect(read.details.observation_id).toBeUndefined();
    expect((await f.session.act({ window_ref: f.ref, observation_id: prior.details.observation_id!, action: "click", x: 75, y: 60 })).details.status).toBe("refused");
    expect(inputs(f.driver)).toHaveLength(0);
  }
});

test("WGC detail cannot silently recapture through the default route", async () => {
  const f = await fixture(true);
  const read = await f.observe("full", { backend: "wgc" });
  expect(read.details.source!.capabilities.detail).toBe("unsupported");
  const before = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.observe(f.ref, undefined, undefined, { image_id: read.details.agent_image!.image_id as string, x: 30, y: 30, width: 50, height: 50 })).details.status).toBe("refused");
  expect((await f.session.observe(f.ref, undefined, undefined, undefined,
    { operation: "crop", observation_id: read.details.observation_id!, hint: read.details.ui!.elements[0].hint })).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls).toHaveLength(before);
});
