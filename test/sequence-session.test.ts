import sharp from "sharp";
import { expect, test, vi } from "vitest";
import { ComputerSession, type Driver, type ComputerMode } from "../src/session.ts";

async function fixture() {
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: "red" } }).png().toBuffer();
  const image = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
  let mode: ComputerMode = "yolo"; let lifetime = "initial";
  const driver: Driver = {
    identity: vi.fn(async () => lifetime), close: vi.fn(async () => {}),
    call: vi.fn(async (name) => name === "list_windows" ? { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } } :
      { content: [image], structuredContent: { pid: 42, window_id: 91, window_bounds: { x: 10, y: 20, width: 40, height: 30 },
        screenshot_width: 40, screenshot_height: 30, screenshot_original_width: 40, screenshot_original_height: 30, elements: [] } }),
  };
  const session = new ComputerSession(driver, () => mode);
  const windows = await session.windows(); const ref = (windows.details.state!.windows as { window_ref: string }[])[0].window_ref;
  return { session, driver, ref, setMode: (value: ComputerMode) => { mode = value; }, replace: () => { lifetime = "replacement"; } };
}

test("sequence captures no context images, revokes old input, and explicit selection returns read-only frames", async () => {
  const f = await fixture(); const overview = await f.session.observe(f.ref);
  const capture = await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 1 });
  expect(capture.details.status).toBe("observed"); expect(capture.content.every(b => b.type === "text")).toBe(true);
  expect(capture.details.sequence!.frames).toHaveLength(1);
  expect(f.driver.call).toHaveBeenLastCalledWith("get_window_state", expect.objectContaining({ include_accessibility_tree: false }), expect.any(AbortSignal));
  const selected = await f.session.sequenceFrames(capture.details.sequence!.sequence_id, "all");
  expect(selected.content.filter(b => b.type === "image")).toHaveLength(1);
  expect(selected.details.selected_frames![0].source.capabilities.input).toBe("none");
  expect(selected.details).not.toHaveProperty("observation_id");
  expect((await f.session.act({ window_ref: f.ref, observation_id: overview.details.observation_id!, action: "click", x: 1, y: 1 })).details.status).toBe("refused");
});

test("retained window pixels are denied after Safe revocation or window recreation", async () => {
  const f = await fixture(); const capture = await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 1 });
  f.setMode("safe"); const denied = await f.session.sequenceFrames(capture.details.sequence!.sequence_id, "all");
  expect(denied.details.status).toBe("refused"); expect(denied.content.every(b => b.type === "text")).toBe(true);
  const calls = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.captureSequence({ display: "primary" }, { duration_ms: 1 })).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls).toHaveLength(calls);
  f.setMode("yolo");
  const fresh = await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 1 });
  expect(fresh.details.status).toBe("observed");
  f.replace();
  const replaced = await f.session.sequenceFrames(fresh.details.sequence!.sequence_id, "all");
  expect(replaced.details.status).toBe("refused");
  expect(replaced.content.every(b => b.type === "text")).toBe(true);
});

test("access revoked during a capture withholds all metadata and pixels", async () => {
  const f = await fixture(); const call = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => { const result = await call(...args); f.setMode("safe"); return result; });
  const result = await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 1 });
  expect(result.details.status).toBe("refused"); expect(result.details).not.toHaveProperty("sequence");
  expect(result.content.every(b => b.type === "text")).toBe(true);
});

test("movement and resize keep lifetime while reporting geometry and clipping the original crop", async () => {
  const f = await fixture(); const images = await Promise.all([40, 25, 50].map(async width => ({ type: "image" as const, mimeType: "image/png",
    data: (await sharp({ create: { width, height: 30, channels: 3, background: "red" } }).png().toBuffer()).toString("base64") })));
  let index = 0;
  f.driver.call = vi.fn<Driver["call"]>(async () => {
    const image = images[index]; const width = [40, 25, 50][index++];
    return { content: [image], structuredContent: { pid: 42, window_id: 91, window_bounds: { x: index * 10, y: 20, width, height: 30 },
      screenshot_width: width, screenshot_height: 30, screenshot_original_width: width, screenshot_original_height: 30 } };
  });
  const result = await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 1000, fps: 10, max_frames: 3,
    region: { x: 10, y: 5, width: 20, height: 10 } });
  expect(result.details.sequence!.frames.map(frame => frame.source.image.dimensions.width)).toEqual([20, 15, 20]);
  expect(result.details.sequence!.frames.map(frame => frame.geometry_changed)).toEqual([false, true, true]);
  expect(result.details.sequence!.frames.every(frame => frame.source.identity.window_ref === f.ref)).toBe(true);
});

test("window replacement during capture stops before publishing that frame and never falls back", async () => {
  const f = await fixture(); const call = f.driver.call; let captures = 0;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => { const result = await call(...args); if (++captures === 2) f.replace(); return result; });
  const result = await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 1000, fps: 10 });
  expect(result.details.sequence!.stop_reason).toBe("target_lost"); expect(result.details.sequence!.frames).toHaveLength(1);
  expect(captures).toBe(2); expect(vi.mocked(f.driver.call).mock.calls.every(([name]) => name === "get_window_state")).toBe(true);
});

test("timeout aborts an in-flight read and leaves the session available for another bounded capture", async () => {
  const f = await fixture(); const call = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (_name, _args, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
  }));
  const result = await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 20, timeout_ms: 50 });
  expect(result.details.sequence!.stop_reason).toBe("timeout"); expect(result.details.sequence!.frames).toHaveLength(0);
  f.driver.call = call;
  expect((await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 1 })).details.status).toBe("observed");
});

test("crop keeps local pixel mapping and invalid sources dispatch no frame", async () => {
  const f = await fixture(); const calls = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.captureSequence({ display: "primary" }, { duration_ms: 0 })).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls).toHaveLength(calls);
  const capture = await f.session.captureSequence({ window_ref: f.ref }, { duration_ms: 1, region: { x: 10, y: 5, width: 20, height: 10 } });
  const result = await f.session.sequenceFrames(capture.details.sequence!.sequence_id, "first");
  expect(result.details.selected_frames![0].source.image.dimensions).toEqual({ width: 20, height: 10 });
  expect(result.details.selected_frames![0].source.image.origin).toEqual({ x: 10, y: 5, relative_to: "window" });
});
