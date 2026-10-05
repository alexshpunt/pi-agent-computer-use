import { expect, test } from "vitest";
import { elementRegion, nativeClickPoint, windowImageMapping, windowRegion } from "../src/highlight-geometry.ts";

const bounds = { x: -100, y: 20, width: 1000, height: 700 };
const state = { window_bounds: bounds, screenshot_width: 500, screenshot_height: 350,
  elements: [{ frame: { x: -100, y: 20, w: 1000, h: 700 }, screenshot_frame: { x: -1, y: -1, w: 501, h: 351 } }] };

test("native rounded AX witnesses prove one scale and a nonzero physical origin, not independent axis ratios", () => {
  const mapping = windowImageMapping(state);
  expect(mapping).toEqual({ offsetX: 1, offsetY: 1, scale: 998 / 500 });
  expect(windowRegion({ image_id: "current", x: 100, y: 50, width: 100, height: 70 }, mapping, bounds))
    .toEqual({ x: 100, y: 120, width: 201, height: 141 });
});

test("detail marks follow the current origin, clip shrinking bounds and never stretch on growth", () => {
  const mapping = windowImageMapping(state);
  const request = { image_id: "current", x: 100, y: 50, width: 100, height: 70 };
  expect(windowRegion(request, mapping, { x: 300, y: 400, width: 1000, height: 700 }))
    .toEqual({ x: 500, y: 500, width: 201, height: 141 });
  expect(windowRegion(request, mapping, { x: 300, y: 400, width: 300, height: 200 }))
    .toEqual({ x: 500, y: 500, width: 100, height: 100 });
  expect(windowRegion(request, mapping, { x: 300, y: 400, width: 2000, height: 1400 }))
    .toEqual({ x: 500, y: 500, width: 201, height: 141 });
});
test("small ambiguous or inconsistent rounded witnesses do not invent a zoom scale", () => {
  expect(windowImageMapping({ ...state, elements: [] })).toBeUndefined();
  expect(windowImageMapping({ ...state, elements: [{ frame: { x: -99, y: 21, w: 10, h: 10 }, screenshot_frame: { x: 0, y: 0, w: 5, h: 5 } }] })).toBeUndefined();
  expect(windowImageMapping({ ...state, elements: [{ frame: { x: -100, y: 20, w: 1000, h: 700 }, screenshot_frame: { x: 30, y: 30, w: 501, h: 351 } }] })).toBeUndefined();
  expect(windowRegion({ image_id: "current", x: 10, y: 20, width: 50, height: 30 }, undefined, bounds)).toBeUndefined();
});

test("AX regions clip to the observed native source and reject absent, empty or malformed bounds", () => {
  expect(elementRegion({ x: -110.2, y: 10, w: 30.4, h: 40.2 }, bounds)).toEqual({ x: -100, y: 20, width: 21, height: 31 });
  for (const frame of [undefined, { x: 0, y: 0, w: NaN, h: 1 }, { x: 2000, y: 0, w: 10, h: 10 }]) expect(elementRegion(frame, bounds)).toBeUndefined();
});

test("pixel targets use exact pinned CUA success receipts; wrong pid, off-source, refusal and unfamiliar text never draw", () => {
  const read = (text: string, pid = 42) => nativeClickPoint([{ type: "text", text }], pid, bounds);
  expect(read("✅ Posted click to Chromium pid 42 at (231,241) (background, no foreground swap)." )).toEqual({ x: 231, y: 241 });
  expect(read("✅ Sent click via SendInput to pid 42 at (231,241) (delivery_mode:foreground)." )).toEqual({ x: 231, y: 241 });
  expect(read("✅ Performed UIA Invoke at (231,241) for pid 42.")).toEqual({ x: 231, y: 241 });
  expect(read("✅ Performed UIA Invoke at (231,241) for pid 42.", 99)).toBeUndefined();
  expect(read("✅ Performed UIA Invoke at (9999,241) for pid 42.")).toBeUndefined();
  expect(read("refused at (231,241) for pid 42.")).toBeUndefined();
  expect(read("✅ Posted click to pid 42.")).toBeUndefined();
});
