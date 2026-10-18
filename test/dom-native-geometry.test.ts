import { beforeAll, expect, test } from "vitest";
import sharp from "sharp";
import { assertNativeDomGeometryContinuity, assertNativeDomRasterQualification, hasNativeDomRasterSchemas, validateNativeDomCrop, validateNativeDomGeometry } from "../src/dom-native-geometry.ts";

const binding = { target_id: "owned-target", tab_id: "owned-tab" };
const target = { pid: 42, window_id: 12345 };
const reference = "p12:3";
const runtime = { source: "a".repeat(40), sha256: "b".repeat(64) };
const qualification = { runtime, browser: { product: "Chrome/155.0.8059.40", revision: "@cfaadc5a132d78e1828635aa8405a499f3e14864" }, dpr: 1.5 };
const geometry = (): any => ({
  format: "native_dom_geometry_v1", status: "ok", mode: "native_element_geometry", ...binding,
  ref: reference, source_ref: reference, source: { frame_id: "frame-one", loader_id: "loader-one", backend_node_id: 9, context_unique_id: "attested-context-one", generation: 2 },
  frame: { kind: "main" },
  css_sample: { connected: true, same_document: true, bounds: { x: 10.5, y: 20.25, width: 12, height: 10 },
    scroll: { x: 0, y: 300.5 }, layout_viewport: { width: 886, height: 546, dpr: 1.5 },
    visual_viewport: { offset_x: 0, offset_y: 0, page_x: 0, page_y: 300.5, width: 886, height: 546, scale: 1 } },
  native: { platform: "windows", ...target, window: { x: 60, y: 60, width: 1350, height: 960 },
    viewport: { x: 71, y: 191, width: 1329, height: 819 }, source: "uia_root_web_area", automation_id: "RootWebArea", framework: "Chrome", opaque_runtime_id: [42, -7, 12] },
  physical_enclosing_rect: { x: 86, y: 221, width: 19, height: 16 }, clipped: false, coordinate_space: "screen_physical_pixels",
  browser_version: structuredClone(qualification.browser), projection: "root_origin_plus_floor_start_ceil_end_at_sampled_dpr",
  qualification: "candidate_not_raster_qualified", atomic: false, input_authority: false,
});
const admit = (value: unknown = geometry()) => validateNativeDomGeometry(value, binding, reference, target);
const crop = (): any => ({ kind: "wgc_crop_v1", ...target, coordinate_space: "screen_physical",
  frame_bounds: { x: 70, y: 61, width: 1330, height: 949 }, source_dimensions: { width: 1330, height: 949 },
  crop_bounds: { x: 86, y: 221, width: 19, height: 16 }, crop_offset: { x: 16, y: 160 }, width: 19, height: 16,
  format: "png", mime_type: "image/png", scale: 1, padding: 0, input_authority: false, paint_freshness: "unverified",
  capture_metadata: { backend: "wgc", paint_freshness: "unverified", frame_bounds: { x: 70, y: 61, width: 1330, height: 949 },
    wait_ms: 2, readback_ms: 1, dequeue_to_copy_ms: 1, reported_frame_age_at_copy_ms: -1,
    frame_timestamp_100ns: 120_000, dequeued_100ns: 100_000, copy_completed_100ns: 110_000,
    frame_after_request_ms: 1, discarded: 0, recreations: 0, resources_reused: true, setup_ms: 0 } });
let image: { type: "image"; mimeType: "image/png"; data: string };
beforeAll(async () => {
  const png = await sharp({ create: { width: 19, height: 16, channels: 4, background: "black" } }).png().toBuffer();
  image = { type: "image", mimeType: "image/png", data: png.toString("base64") };
});
const admitCrop = (value: unknown = crop(), pixels = image, sample = admit(), allowed: any = qualification, actualRuntime: any = runtime) =>
  validateNativeDomCrop(value, pixels, sample, allowed, actualRuntime);

test("fractional CSS edges use sampled DPR and exact native viewport origin without promoting the candidate", () => {
  const value = geometry(), result = admit(value);
  expect(result.physical_enclosing_rect).toEqual({ x: 86, y: 221, width: 19, height: 16 });
  expect(result.qualification).toBe("candidate_not_raster_qualified");
  expect(result.atomic).toBe(false); expect(result.input_authority).toBe(false);
  value.source.frame_id = "changed"; value.native.opaque_runtime_id[0] = 8;
  expect(result.source.frame_id).toBe("frame-one"); expect(result.native.opaque_runtime_id[0]).toBe(42);
});

test("foreign, clipped, unready or exceptional geometry cannot authorize pixels", () => {
  const changes = [
    (v: any) => v.status = "refused", (v: any) => v.mode = "snapshot", (v: any) => v.ref = "p11:3",
    (v: any) => v.source_ref = "p11:3", (v: any) => v.target_id = "foreign", (v: any) => v.tab_id = "foreign",
    (v: any) => v.frame.kind = "iframe", (v: any) => v.native.pid++, (v: any) => v.native.window_id++,
    (v: any) => v.native.source = "hidden_renderer_hwnd", (v: any) => v.native.framework = "other",
    (v: any) => v.native.automation_id = "page-authored-id", (v: any) => v.clipped = true,
    (v: any) => v.input_authority = true, (v: any) => v.atomic = true, (v: any) => v.qualification = "qualified",
    (v: any) => v.css_sample.connected = false, (v: any) => v.css_sample.same_document = false,
    (v: any) => v.native.viewport.width++, (v: any) => v.native.viewport.height++,
    (v: any) => v.physical_enclosing_rect.x++, (v: any) => v.physical_enclosing_rect.width--,
    (v: any) => v.css_sample.visual_viewport.scale = 1.01, (v: any) => v.css_sample.visual_viewport.offset_y = 1,
    (v: any) => v.css_sample.visual_viewport.page_y = 300, (v: any) => v.css_sample.layout_viewport.dpr = 1.499,
    (v: any) => v.native.viewport.x = 59, (v: any) => v.native.opaque_runtime_id = [],
    (v: any) => v.native.opaque_runtime_id = [2 ** 31], (v: any) => v.source.backend_node_id = 0,
    (v: any) => v.source.context_unique_id = "", (v: any) => v.source.frame_id += "\0",
    (v: any) => v.source.generation = -1, (v: any) => v.css_sample.bounds.width = 0,
    (v: any) => v.css_sample.bounds.x = -1, (v: any) => v.native.window.x = 0.5,
    (v: any) => v.css_sample.layout_viewport.width = 886.5,
  ];
  for (const change of changes) { const value = geometry(); change(value); expect(() => admit(value)).toThrow(); }
  for (const bad of [NaN, Infinity, -Infinity, "1", null, 1_000_000_001]) {
    const value = geometry(); value.css_sample.bounds.x = bad; expect(() => admit(value)).toThrow();
  }
});

test("every geometry record is closed and its bounded required evidence cannot disappear", () => {
  for (const field of Object.keys(geometry())) { const value = geometry(); delete value[field]; expect(() => admit(value)).toThrow(); }
  for (const path of [[], ["source"], ["frame"], ["native"], ["native", "window"], ["native", "viewport"],
    ["css_sample"], ["css_sample", "bounds"], ["css_sample", "scroll"], ["css_sample", "layout_viewport"],
    ["css_sample", "visual_viewport"], ["browser_version"], ["physical_enclosing_rect"]]) {
    const value = geometry(); let record = value; for (const part of path) record = record[part]; record.private = "not exported";
    expect(() => admit(value)).toThrow();
  }
  const huge = geometry(); huge.source.context_unique_id = "🧭".repeat(4200); expect(() => admit(huge)).toThrow();
  for (const bad of [null, [], "geometry", true]) expect(() => admit(bad)).toThrow();
});

test("equal document and geometry samples may have distinct per-call attested isolated contexts", () => {
  const before = admit(), next = geometry(); next.source.context_unique_id = "another-attested-context";
  expect(() => assertNativeDomGeometryContinuity(before, admit(next))).not.toThrow();
  const changes = [
    (v: any) => v.source.frame_id += "2", (v: any) => v.source.loader_id += "2", (v: any) => v.source.backend_node_id++,
    (v: any) => v.source.generation++, (v: any) => v.native.opaque_runtime_id[0]++, (v: any) => v.browser_version.revision += "2",
    (v: any) => { v.native.window.x--; },
    (v: any) => { v.css_sample.scroll.y++; v.css_sample.visual_viewport.page_y++; },
    (v: any) => { v.css_sample.bounds.x++; v.physical_enclosing_rect.x += 2; },
  ];
  for (const change of changes) { const value = geometry(); change(value); const after = admit(value);
    expect(() => assertNativeDomGeometryContinuity(before, after)).toThrow(); }
});

test("pixel release requires exact runtime source/hash and tested browser revision/DPR, never candidate flags alone", () => {
  const sample = admit();
  expect(() => assertNativeDomRasterQualification(sample, qualification, runtime)).not.toThrow();
  for (const absent of [undefined, null, true, {}, { ...qualification, extra: true }])
    expect(() => assertNativeDomRasterQualification(sample, absent as any, runtime)).toThrow();
  for (const changed of [
    { ...qualification, runtime: { ...runtime, source: "c".repeat(40) } },
    { ...qualification, runtime: { ...runtime, sha256: "c".repeat(64) } },
    { ...qualification, browser: { ...qualification.browser, product: "Chrome/new" } },
    { ...qualification, browser: { ...qualification.browser, revision: "@new" } }, { ...qualification, dpr: 1 },
  ]) expect(() => assertNativeDomRasterQualification(sample, changed, runtime)).toThrow();
  for (const actual of [undefined, null, { ...runtime, sha256: "d".repeat(64) }, { source: "0.34.0", sha256: runtime.sha256 }])
    expect(() => assertNativeDomRasterQualification(sample, qualification, actual as any)).toThrow();
  expect(() => validateNativeDomCrop(crop(), image, sample, undefined, runtime)).toThrow();
});

test("lossless crop uses the actual nonzero WGC frame origin and retains unverified paint without input authority", () => {
  const result = admitCrop();
  expect(result.crop_offset).toEqual({ x: 16, y: 160 });
  expect(result.scale).toBe(1); expect(result.padding).toBe(0); expect(result.input_authority).toBe(false);
  expect(result.paint_freshness).toBe("unverified");
  expect(result.capture_metadata.reported_frame_age_at_copy_ms).toBe(-1);
  const value = crop(); const isolated = admitCrop(value); value.capture_metadata.frame_bounds.x++;
  expect(isolated.capture_metadata.frame_bounds.x).toBe(70);
});

test("negative native origins remain exact without substituting GetWindowRect or fitting offsets", () => {
  const value = geometry(); for (const rect of [value.native.window, value.native.viewport, value.physical_enclosing_rect]) rect.x -= 1000;
  const pixels = crop(); pixels.frame_bounds.x -= 1000; pixels.crop_bounds.x -= 1000; pixels.capture_metadata.frame_bounds.x -= 1000;
  expect(admitCrop(pixels, image, admit(value)).crop_offset.x).toBe(16);
  pixels.crop_offset.x = pixels.crop_bounds.x - value.native.window.x;
  expect(() => admitCrop(pixels, image, admit(value))).toThrow();
});

test("wider captures, alternative backends, padding, scaling, altered bounds or malformed timing withhold pixels", () => {
  const changes = [
    (v: any) => v.pid++, (v: any) => v.window_id++, (v: any) => v.kind = "zoom",
    (v: any) => v.coordinate_space = "window_local", (v: any) => v.scale = 2, (v: any) => v.padding = 0.2,
    (v: any) => v.input_authority = true, (v: any) => v.paint_freshness = "verified",
    (v: any) => v.frame_bounds.width++, (v: any) => v.source_dimensions.height--,
    (v: any) => v.crop_bounds.width++, (v: any) => v.crop_offset.x++, (v: any) => v.width++,
    (v: any) => v.capture_metadata.backend = "default", (v: any) => v.capture_metadata.frame_bounds.x++,
    (v: any) => v.capture_metadata.copy_completed_100ns = 1,
    (v: any) => v.capture_metadata.dequeued_100ns = -1, (v: any) => v.capture_metadata.resources_reused = "true",
    (v: any) => v.capture_metadata.dequeued_100ns = Number.MAX_SAFE_INTEGER + 1,
    (v: any) => v.capture_metadata.dequeued_100ns += 1,
    (v: any) => v.capture_metadata.reported_frame_age_at_copy_ms = 0,
  ];
  for (const change of changes) { const value = crop(); change(value); expect(() => admitCrop(value)).toThrow(); }
  for (const record of [[], ["frame_bounds"], ["source_dimensions"], ["crop_bounds"], ["crop_offset"], ["capture_metadata"]]) {
    const value = crop(); let r = value; for (const part of record) r = r[part]; r.private = "secret";
    expect(() => admitCrop(value)).toThrow();
  }
  for (const field of Object.keys(crop())) { const value = crop(); delete value[field]; expect(() => admitCrop(value)).toThrow(); }
});

test("PNG type, canonical base64 and original output dimensions are checked before pixels can be released", () => {
  for (const changed of [{ ...image, mimeType: "image/jpeg" }, { ...image, type: "text" },
    { ...image, data: `${image.data}\n` }, { ...image, data: "not base64" }, { ...image, data: "" }, { ...image, private: "not forwarded" }])
    expect(() => admitCrop(crop(), changed as any)).toThrow();
  const bytes = Buffer.from(image.data, "base64"); bytes.writeUInt32BE(20, 16);
  expect(() => admitCrop(crop(), { ...image, data: bytes.toString("base64") })).toThrow();
  const signature = Buffer.from(image.data, "base64"); signature[0] = 0;
  expect(() => admitCrop(crop(), { ...image, data: signature.toString("base64") })).toThrow();
});

test("runtime admission requires the flat compatible native schema and never borrows legacy zoom", () => {
  const tools = () => [
    { name: "get_browser_state", inputSchema: { type: "object", properties: { native_geometry_ref: { type: "string", minLength: 1, maxLength: 256 } } } },
    { name: "zoom", inputSchema: { type: "object", additionalProperties: false, required: ["window_id", "x1", "y1", "x2", "y2"],
      properties: { capture_backend: { type: "string", enum: ["default", "wgc"] }, pid: { type: "integer", minimum: 1, maximum: 2147483647 },
        window_id: { type: "integer", minimum: 1 }, ...Object.fromEntries(["x1", "y1", "x2", "y2"].map(key => [key, { type: "number" }])) } } },
  ];
  expect(hasNativeDomRasterSchemas(tools())).toBe(true);
  for (const change of [
    (v: any) => delete v[0].inputSchema.properties.native_geometry_ref,
    (v: any) => v[0].inputSchema.properties.native_geometry_ref.maxLength = 10000,
    (v: any) => v[1].inputSchema.properties.capture_backend.enum = ["default"],
    (v: any) => v[1].inputSchema.required.pop(),
    (v: any) => delete v[1].inputSchema.properties.pid,
    (v: any) => v[1].inputSchema.properties.pid.minimum = 0,
    (v: any) => v[1].inputSchema.properties.x1.type = "string",
    (v: any) => v[1].inputSchema.additionalProperties = true,
    (v: any) => v[1].inputSchema.allOf = [],
    (v: any) => v[1].inputSchema.anyOf = [],
    (v: any) => v[1].inputSchema.oneOf = [],
    (v: any) => v.push(v[1]),
  ]) { const value = tools(); change(value); expect(hasNativeDomRasterSchemas(value)).toBe(false); }
  expect(hasNativeDomRasterSchemas([])).toBe(false);
});