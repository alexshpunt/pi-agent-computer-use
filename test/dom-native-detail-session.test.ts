import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";
import type { NativeDomRasterQualification, NativeDomRuntimeIdentity } from "../src/dom-native-geometry.ts";

const runtime: NativeDomRuntimeIdentity = { source: "a".repeat(40), sha256: "b".repeat(64) };
const qualification: NativeDomRasterQualification = { runtime, browser: { product: "Chrome/155.0.8059.40", revision: "@tested" }, dpr: 1.5 };
const target = { pid: 42, window_id: 91 };
const bounds = { x: 86, y: 221, width: 19, height: 16 };
const frame = { x: 70, y: 61, width: 1330, height: 949 };
const geometry = (ref: unknown, context: number): Record<string, unknown> => ({
  format: "native_dom_geometry_v1", status: "ok", mode: "native_element_geometry", target_id: "bt-original", tab_id: "tab-original",
  ref, source_ref: ref, source: { frame_id: "frame-private", loader_id: "loader-private", backend_node_id: 9, context_unique_id: `private-context-${context}`, generation: 2 },
  frame: { kind: "main" }, css_sample: { connected: true, same_document: true, bounds: { x: 10.5, y: 20.25, width: 12, height: 10 },
    scroll: { x: 0, y: 300.5 }, layout_viewport: { width: 886, height: 546, dpr: 1.5 },
    visual_viewport: { offset_x: 0, offset_y: 0, page_x: 0, page_y: 300.5, width: 886, height: 546, scale: 1 } },
  native: { platform: "windows", ...target, window: { x: 60, y: 60, width: 1350, height: 960 }, viewport: { x: 71, y: 191, width: 1329, height: 819 },
    source: "uia_root_web_area", automation_id: "RootWebArea", framework: "Chrome", opaque_runtime_id: [42, -7, 12] },
  physical_enclosing_rect: bounds, clipped: false, coordinate_space: "screen_physical_pixels", browser_version: qualification.browser,
  projection: "root_origin_plus_floor_start_ceil_end_at_sampled_dpr", qualification: "candidate_not_raster_qualified", atomic: false, input_authority: false,
});
const crop = (): Record<string, unknown> => ({ kind: "wgc_crop_v1", ...target, coordinate_space: "screen_physical", frame_bounds: frame,
  source_dimensions: { width: 1330, height: 949 }, crop_bounds: bounds, crop_offset: { x: 16, y: 160 }, width: 19, height: 16,
  format: "png", mime_type: "image/png", scale: 1, padding: 0, input_authority: false, paint_freshness: "unverified",
  capture_metadata: { backend: "wgc", paint_freshness: "unverified", frame_bounds: frame, wait_ms: 2, readback_ms: 1, dequeue_to_copy_ms: 1,
    reported_frame_age_at_copy_ms: -1, frame_timestamp_100ns: 120000, dequeued_100ns: 100000, copy_completed_100ns: 110000,
    frame_after_request_ms: 1, discarded: 0, recreations: 0, resources_reused: true, setup_ms: 0 } });

type RasterDriver = Driver & { nativeDomRaster?: { runtime: NativeDomRuntimeIdentity; qualification: NativeDomRasterQualification } };
async function fixture({ qualified = true, frameKind = "main" } = {}) {
  let life: string | undefined = `PiComputerUse.${"a".repeat(32)}:42:1`, mode: ComputerMode = "yolo", serial = 0, samples = 0;
  let after: ((stage: string, result: DriverResult) => void) | undefined;
  const raw = await sharp({ create: { width: 19, height: 16, channels: 4, background: { r: 24, g: 48, b: 96, alpha: 1 } } }).png().toBuffer();
  const image = { type: "image" as const, mimeType: "image/png", data: raw.toString("base64") };
  const observer = vi.fn(async (_frame: unknown, _signal?: AbortSignal) => ({ status: "shown" as const }));
  const driver: RasterDriver = {
    nativeDomRaster: qualified ? structuredClone({ runtime, qualification }) : undefined, domInspection: true,
    identity: vi.fn(async () => life), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [target] } };
      if (name === "start_session") return { content: [], structuredContent: { active: true, session: args.session } };
      if (name === "end_session") return { content: [], structuredContent: { active: false, session: args.session } };
      let stage: string, result: DriverResult;
      if (name === "zoom") { stage = "crop"; result = { content: [structuredClone(image)], structuredContent: structuredClone(crop()) }; }
      else if (name === "get_browser_state" && args.native_geometry_ref) {
        stage = `geometry${++samples}`; result = { content: [], structuredContent: structuredClone(geometry(args.native_geometry_ref, samples)) };
      } else if (name === "get_browser_state" && !args.snapshot_format) return { content: [], structuredContent: {
        status: "ok", mode: "bind", binding_quality: "exact", endpoint_access_class: "driver_owned", target_id: "bt-original",
        tabs: [{ tab_id: "tab-original", active: true, title: "Fixture", url: "http://127.0.0.1/" }] } };
      else if (name === "get_browser_state") {
        const id = `p${++serial}`;
        stage = "snapshot"; result = { content: [], structuredContent: { status: "ok", mode: "snapshot", target_id: "bt-original", tab_id: "tab-original",
          page: { url: "http://127.0.0.1/", title: "Fixture" }, snapshot: { id, format: "dom_inspect_v1", complete: true, collection_complete: true,
            matched_count: 1, returned_count: 1, truncated: false, omitted: { nodes: 0, depth: 0, frames: 0, metadata: 0, text: 0, hidden_filtered: 0 }, scope: "document" },
          elements: [{ ref: `${id}:0`, frame: { ref: "df-main", kind: frameKind }, tag: "button", attributes: { "data-testid": "advance" }, text: "Advance", text_truncated: false,
            role: "button", name: "Advance", value: null, states: {}, visibility: "visible", bounds_css: null, coordinate_space: "document_css_pixels" }] } };
      } else throw Error(`Unexpected native call ${name}`);
      after?.(stage, result); return result;
    }),
  };
  const session = new ComputerSession(driver, () => mode, undefined, observer);
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const observed = await session.observeDom(ref), id = observed.details.observation_id!, hint = observed.details.dom!.elements[0].hint;
  const calls = () => vi.mocked(driver.call).mock.calls;
  const detail = (operation: "crop" | "highlight" = "crop", signal?: AbortSignal) => session.inspectDom(ref, id, { operation, hint }, signal);
  return { session, ref, id, hint, observed, driver, observer, image, calls, detail, setLife(v: string | undefined) { life = v; },
    setMode(v: ComputerMode) { mode = v; }, after(v: typeof after) { after = v; } };
}

test("without explicit byte/browser raster qualification a DOM crop does not acquire native pixels", async () => {
  const f = await fixture({ qualified: false }), count = f.calls().length;
  const result = await f.detail();
  expect(result.details.status).toBe("refused"); expect(f.calls()).toHaveLength(count);
  expect(result.details.dom_native_detail_refusal).toEqual({ phase: "admission", pixels_withheld: true, input_authority: false, fallback: false });
  expect((await f.session.checkDom(f.ref, f.id)).details.dom).toEqual(f.observed.details.dom);
});

test("fresh readonly crop brackets one exact WGC acquisition with three equal qualified geometry samples", async () => {
  const f = await fixture(), count = f.calls().length, result = await f.detail();
  expect(result.details.status).toBe("observed"); expect(result.isError).not.toBe(true);
  expect(result.content.filter(block => block.type === "image")).toEqual([f.image]);
  const calls = f.calls().slice(count);
  expect(calls.map(([name]) => name)).toEqual(["get_browser_state", "get_browser_state", "zoom", "get_browser_state"]);
  for (const [, args] of calls.filter(([name]) => name === "get_browser_state")) expect(args).toMatchObject({ target_id: "bt-original", tab_id: "tab-original", native_geometry_ref: "p1:0", snapshot_format: "dom_inspect_v1" });
  expect(calls[2][1]).toEqual({ ...target, session: calls[0][1].session, capture_backend: "wgc", x1: 86, y1: 221, x2: 105, y2: 237 });
  expect(result.details.source?.capabilities).toEqual({ read: true, input: "none", detail: "unsupported" });
  expect(result.details.source?.image.coordinate_space).toBe("detail_image_pixels");
  expect(result.details.action_capability).toBeUndefined(); expect(result.details.ui).toBeUndefined(); expect(result.details.dom_geometry).toBeUndefined();
  expect((result.details as any).dom_native_detail).toMatchObject({ operation: "crop", hint: f.hint, physical_enclosing_rect: bounds, frame_bounds: frame, atomic: false, input_authority: false, paint_freshness: "unverified" });
  expect(JSON.stringify(result)).not.toMatch(/bt-original|tab-original|p1:0|frame-private|loader-private|private-context|backend_node_id|context_unique_id/);
  expect((await f.session.checkDom(f.ref, f.id)).details.dom).toEqual(f.observed.details.dom);
  expect((await f.session.act({ window_ref: f.ref, observation_id: f.id, action: "click", x: 1, y: 1 })).details.status).toBe("refused");
});

test("highlight marks only fresh native pixels and the proven human-only physical rectangle without inventing UIA elements", async () => {
  const f = await fixture(), result = await f.detail("highlight");
  expect(result.details.status).toBe("observed");
  const output = result.content.find(block => block.type === "image"); expect(output?.type).toBe("image");
  expect(output).not.toEqual(f.image); expect(result.details.ui).toBeUndefined();
  const bytes = Buffer.from((output as typeof f.image).data, "base64"), metadata = await sharp(bytes).metadata();
  expect([metadata.width, metadata.height]).toEqual([19, 16]);
  const raw = await sharp(bytes).raw().toBuffer(), original = await sharp(Buffer.from(f.image.data, "base64")).raw().toBuffer();
  expect(raw.subarray((8 * 19 + 8) * 4, (8 * 19 + 8) * 4 + 4)).toEqual(original.subarray((8 * 19 + 8) * 4, (8 * 19 + 8) * 4 + 4));
  expect(f.observer).toHaveBeenCalledTimes(1);
  expect(f.observer.mock.calls[0][0]).toMatchObject({ target, bounds: { x: 60, y: 60, width: 1350, height: 960 }, mark: { kind: "detail", region: bounds } });
  expect((await f.session.checkDom(f.ref, f.id)).details.dom).toEqual(f.observed.details.dom);
});

test.each(["safe", "reused", "closed", "cancelled", "iframe"])("%s source refuses before geometry or crop dispatch", async change => {
  const f = await fixture({ frameKind: change === "iframe" ? "iframe" : "main" }), abort = new AbortController(), count = f.calls().length;
  if (change === "safe") f.setMode("safe"); if (change === "reused") f.setLife("two"); if (change === "closed") f.setLife(undefined); if (change === "cancelled") abort.abort();
  expect((await f.detail("crop", abort.signal)).details.status).toBe("refused"); expect(f.calls()).toHaveLength(count);
});

test.each(["geometry1", "geometry2", "crop", "geometry3"])("cancelled or revoked %s seam withholds all pixels without later calls", async stage => {
  for (const change of ["cancelled", "safe", "reused", "qualification"]) {
    const f = await fixture(), abort = new AbortController();
    f.after(current => { if (current !== stage) return; if (change === "cancelled") abort.abort(); if (change === "safe") f.setMode("safe");
      if (change === "reused") f.setLife("reused"); if (change === "qualification") f.driver.nativeDomRaster = undefined; });
    const result = await f.detail("crop", abort.signal);
    expect(result.details.status).toBe("refused"); expect(result.content.every(block => block.type === "text")).toBe(true);
    expect((result.details as any).dom_native_detail).toBeUndefined(); expect(f.observer).not.toHaveBeenCalled();
    expect(f.calls().filter(([, args]) => args.native_geometry_ref).length).toBeLessThanOrEqual(stage === "geometry1" ? 1 : stage === "geometry2" ? 2 : 3);
    expect((await f.session.checkDom(f.ref, f.id)).details.status).toBe("refused");
  }
});

test("changed ready geometry or a mismatched qualification stops before WGC capture", async () => {
  for (const change of ["loader", "qualification"]) {
    const f = await fixture();
    if (change === "qualification") f.driver.nativeDomRaster = { runtime, qualification: { ...qualification, browser: { ...qualification.browser, revision: "@unqualified" } } };
    f.after((stage, result) => { if (change === "loader" && stage === "geometry2") (result.structuredContent!.source as any).loader_id = "changed"; });
    expect((await f.detail()).details.status).toBe("refused");
    expect(f.calls().some(([name]) => name === "zoom")).toBe(false);
    expect((await f.session.checkDom(f.ref, f.id)).details.status).toBe("refused");
  }
});

test("revocation during the optional human mark withholds pixels and retires the source", async () => {
  const f = await fixture();
  f.observer.mockImplementation(async () => { f.setMode("safe"); return { status: "shown" }; });
  const result = await f.detail("highlight");
  expect(result.details.status).toBe("refused"); expect(result.content.every(block => block.type === "text")).toBe(true);
  expect((result.details as any).dom_native_detail).toBeUndefined();
  expect((await f.session.checkDom(f.ref, f.id)).details.status).toBe("refused");
});
test("changed document, layout or native identity after crop withholds pixels and retires the original source", async () => {
  for (const change of ["loader", "backend", "runtime", "layout", "window", "ref"]) {
    const f = await fixture(); f.after((stage, result) => {
      if (stage !== "geometry3") return; const value = result.structuredContent as any;
      if (change === "loader") value.source.loader_id = "changed"; if (change === "backend") value.source.backend_node_id++;
      if (change === "runtime") value.native.opaque_runtime_id[0]++; if (change === "layout") { value.css_sample.scroll.y++; value.css_sample.visual_viewport.page_y++; }
      if (change === "window") value.native.window.x--; if (change === "ref") value.source_ref = "p99:0";
    });
    const result = await f.detail(); expect(result.details.status).toBe("refused"); expect(result.content.every(block => block.type === "text")).toBe(true);
    expect((await f.session.checkDom(f.ref, f.id)).details.status).toBe("refused");
  }
});

test("alternative capture route, scaled or malformed pixels and failed native replies cannot escape as detail", async () => {
  for (const change of ["backend", "scale", "size", "png", "native_error", "two_images", "geometry_image"]) {
    const f = await fixture(); f.after((stage, result) => {
      if (stage === "geometry1" && change === "geometry_image") result.content.push(f.image);
      if (stage !== "crop") return; const value = result.structuredContent as any;
      if (change === "backend") value.capture_metadata.backend = "default"; if (change === "scale") value.scale = 2; if (change === "size") value.width++;
      if (change === "png") result.content = [{ ...f.image, data: "AAAA" }]; if (change === "native_error") result.isError = true;
      if (change === "two_images") result.content.push(f.image);
    });
    const result = await f.detail(); expect(result.details.status).toBe("refused"); expect(result.content.every(block => block.type === "text")).toBe(true);
    expect((await f.session.checkDom(f.ref, f.id)).details.status).toBe("refused");
  }
});

test.each([
  ["geometry1", "first_geometry", "throw"], ["geometry2", "second_geometry", "native_error"],
  ["geometry2", "geometry_continuity", "changed_loader"], ["crop", "capture", "throw"],
  ["crop", "crop_validation", "invalid_crop"], ["geometry3", "final_geometry", "invalid_ref"],
  ["geometry3", "final_continuity", "changed_loader"], ["crop", "annotation", "invalid_png_body"],
] as const)("%s %s failure reports only the closed phase and withholds all pixels", async (seam, phase, failure) => {
  const f = await fixture();
  f.after((stage, result) => {
    if (stage !== seam) return;
    if (failure === "throw") throw Error("private-context-123 https://private.invalid/ raw native prose");
    if (failure === "native_error") { result.isError = true; result.structuredContent = { private: "private-context-123" }; }
    if (failure === "changed_loader") (result.structuredContent!.source as any).loader_id = "changed-private-loader";
    if (failure === "invalid_crop") result.structuredContent!.scale = 2;
    if (failure === "invalid_ref") result.structuredContent!.source_ref = "private-ref";
    if (failure === "invalid_png_body") result.content = [{ ...f.image, data: Buffer.from(f.image.data, "base64").subarray(0, 33).toString("base64") }];
  });
  const result = await f.detail(failure === "invalid_png_body" ? "highlight" : "crop");
  expect(result.details.status).toBe("refused");
  expect(result.details.dom_native_detail_refusal).toEqual({ phase, pixels_withheld: true, input_authority: false, fallback: false });
  expect(result.content.every(block => block.type === "text")).toBe(true);
  expect(result.content.find(block => block.type === "text")?.text).toContain(phase);
  expect(result.details.dom_native_detail).toBeUndefined(); expect(f.observer).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/private-context|private\.invalid|native prose|private-loader|private-ref|frame-private|backend_node_id/);
  expect((await f.session.checkDom(f.ref, f.id)).details.status).toBe("refused");
});

test("human highlight revocation reports its phase without leaking observer failures or pixels", async () => {
  const f = await fixture();
  f.observer.mockImplementation(async () => { f.setMode("safe"); return { status: "shown" }; });
  const result = await f.detail("highlight");
  expect(result.details.dom_native_detail_refusal).toEqual({ phase: "human_highlight", pixels_withheld: true, input_authority: false, fallback: false });
  expect(result.content.every(block => block.type === "text")).toBe(true);
  expect((await f.session.checkDom(f.ref, f.id)).details.status).toBe("refused");
});

test("native DOM detail presentation exposes pixel provenance and limits without internal capabilities", async () => {
  const { presentComputerResult } = await import("../src/provider.ts");
  const f = await fixture(), result = await f.detail("highlight");
  const before = JSON.stringify(result), summary = presentComputerResult({ appSource: id => `computer:app/${id}` }, result);
  expect(summary).toContain(`DOM native highlight: ${f.hint}`);
  expect(summary).toContain('WGC frame: {"x":70,"y":61,"width":1330,"height":949}');
  expect(summary).toContain('Physical region: {"x":86,"y":221,"width":19,"height":16}');
  expect(summary).toContain("DPR=1.5");
  expect(summary).toContain("candidate_not_raster_qualified");
  expect(summary).toContain("atomic=false; input=none; paint=unverified");
  expect(summary).not.toMatch(/bt-original|tab-original|p1:0|frame-private|loader-private|private-context|backend_node_id|context_unique_id/);
  expect(summary.length).toBeLessThan(2000);
  expect(JSON.stringify(result)).toBe(before);
});