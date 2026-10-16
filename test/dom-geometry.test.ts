import { expect, test } from "vitest";
import { validateDomGeometry } from "../src/dom-geometry.ts";

const binding = { target_id: "owned-target", tab_id: "owned-tab" };
const reference = "p12:3";
const native = (): any => ({ status: "ok", mode: "element_geometry", ...binding, ref: reference, source_ref: reference,
  frame: { kind: "main" }, coordinate_space: "frame_viewport_css_pixels", viewport: "layout", method: "isolated_cssom_border_box",
  native_pixel_mapping: "unavailable", atomic: false, connected: true, same_document: true,
  bounds: { x: -3.25, y: 20.5, width: 80.25, height: 30.125 }, scroll: { x: -5.5, y: 120.25 },
  visual_viewport: { offset_x: 1.25, offset_y: 2.5, page_x: -4.25, page_y: 122.75, width: 886, height: 546, scale: 1.25 } });

test("current readonly geometry keeps fractional viewport CSS values without a DPR conversion", () => {
  const value = native(); value.device_pixel_ratio = 1.5;
  const result = validateDomGeometry(value, binding, reference);
  expect(result.bounds).toEqual(value.bounds);
  expect(result.scroll).toEqual(value.scroll);
  expect(result.visual_viewport).toEqual(value.visual_viewport);
  expect(result.coordinate_space).toBe("frame_viewport_css_pixels");
  expect(result.native_pixel_mapping).toBe("unavailable");
  expect(result.atomic).toBe(false);
  expect(result).not.toHaveProperty("device_pixel_ratio");
  result.bounds.x = 99;
  expect(value.bounds.x).toBe(-3.25);
});

test("zero-area hidden elements remain valid samples, not proof of visibility or absence", () => {
  const value = native(); value.bounds = { x: 0, y: 0, width: 0, height: 0 }; value.visibility = "hidden";
  const result = validateDomGeometry(value, binding, reference);
  expect(result.bounds).toEqual(value.bounds);
  expect(result).not.toHaveProperty("visibility");
});

test("foreign, retired, detached or unqualified sources cannot become CSS geometry", () => {
  const changes = [
    (value: any) => value.status = "refused",
    (value: any) => value.mode = "snapshot",
    (value: any) => value.target_id = "foreign-target",
    (value: any) => value.tab_id = "foreign-tab",
    (value: any) => value.ref = "p11:3",
    (value: any) => value.source_ref = "p11:3",
    (value: any) => value.frame.kind = "iframe",
    (value: any) => value.frame.kind = "oopif",
    (value: any) => value.coordinate_space = "document_css_pixels",
    (value: any) => value.viewport = "visual",
    (value: any) => value.method = "guessed_dpr",
    (value: any) => value.native_pixel_mapping = "qualified",
    (value: any) => value.atomic = true,
    (value: any) => value.connected = false,
    (value: any) => value.same_document = false,
    (value: any) => value.refusal = { code: "browser_ref_stale" },
    (value: any) => value.error = "unavailable",
    (value: any) => value.exceptionDetails = { text: "side effect checking failed" },
    (value: any) => value.wasThrown = true,
  ];
  for (const change of changes) {
    const value = native(); change(value);
    expect(() => validateDomGeometry(value, binding, reference)).toThrow();
  }
  for (const ref of ["", "p12:", "p12:hint", "p12:-1", "p12:3\0", "x".repeat(129)])
    expect(() => validateDomGeometry({ ...native(), ref, source_ref: ref }, binding, ref)).toThrow();
});

test("required flags and records cannot be omitted or coerced into success", () => {
  for (const field of ["status", "mode", "target_id", "tab_id", "ref", "source_ref", "frame", "coordinate_space", "viewport", "method",
    "native_pixel_mapping", "atomic", "connected", "same_document", "bounds", "scroll", "visual_viewport"]) {
    const value = native(); delete value[field];
    expect(() => validateDomGeometry(value, binding, reference)).toThrow();
  }
  for (const value of [null, [], 1, "geometry", true])
    expect(() => validateDomGeometry(value, binding, reference)).toThrow();
  for (const field of ["atomic", "connected", "same_document"]) {
    const value = native(); value[field] = String(value[field]);
    expect(() => validateDomGeometry(value, binding, reference)).toThrow();
  }
});

test("finite bounded coordinates, extents and viewport dimensions are enforced", () => {
  for (const [group, fields] of [["bounds", ["x", "y", "width", "height"]], ["scroll", ["x", "y"]],
    ["visual_viewport", ["offset_x", "offset_y", "page_x", "page_y", "width", "height", "scale"]]] as const) {
    for (const field of fields) {
      for (const bad of [Number.NaN, Infinity, -Infinity, 1_000_000_001, -1_000_000_001, "1", null, true]) {
        const value = native(); value[group][field] = bad;
        expect(() => validateDomGeometry(value, binding, reference)).toThrow();
      }
      const missing = native(); delete missing[group][field];
      expect(() => validateDomGeometry(missing, binding, reference)).toThrow();
    }
    const wrong = native(); wrong[group] = [];
    expect(() => validateDomGeometry(wrong, binding, reference)).toThrow();
  }
  for (const [group, field, bad] of [["bounds", "width", -1], ["bounds", "height", -1], ["visual_viewport", "width", 0],
    ["visual_viewport", "height", -1], ["visual_viewport", "scale", 0]]) {
    const value = native(); value[group][field] = bad;
    expect(() => validateDomGeometry(value, binding, reference)).toThrow();
  }
  for (const axis of ["x", "y"]) {
    const value = native(); value.bounds[axis] = 1_000_000_000;
    expect(() => validateDomGeometry(value, binding, reference)).toThrow();
  }
});

test("unknown metadata and native capabilities never survive the bounded projection", () => {
  const value = native(); value.extra = "metadata"; value.frame.ref = "native-frame-id"; value.objectId = "native-object";
  value.bounds.native_x = 10; value.scroll.target_id = "foreign"; value.visual_viewport.device_pixel_ratio = 1.5;
  const result = validateDomGeometry(value, binding, reference);
  expect(Object.keys(result).sort()).toEqual(["atomic", "bounds", "connected", "coordinate_space", "method", "native_pixel_mapping",
    "same_document", "scroll", "viewport", "visual_viewport"].sort());
  expect(Object.keys(result.bounds)).toEqual(["x", "y", "width", "height"]);
  expect(Object.keys(result.scroll)).toEqual(["x", "y"]);
  expect(Object.keys(result.visual_viewport)).toEqual(["offset_x", "offset_y", "page_x", "page_y", "width", "height", "scale"]);
  for (const key of ["target_id", "tab_id", "ref", "source_ref", "frame", "objectId", "extra"])
    expect(result).not.toHaveProperty(key);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
});

test("the native result budget counts UTF8 bytes, including discarded metadata", () => {
  const value = native(); value.extra = "🧭".repeat(4200);
  expect(JSON.stringify(value).length).toBeLessThan(16_384);
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(16_384);
  expect(() => validateDomGeometry(value, binding, reference)).toThrow();
});
