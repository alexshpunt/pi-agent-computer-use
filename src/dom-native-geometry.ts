import { isDeepStrictEqual } from "node:util";
import type { DomBinding } from "./dom-inspection.ts";
import type { Content, WindowTarget } from "./session.ts";

/** A physical screen rectangle, never an input coordinate or a DOM/native node join. */
export interface NativeDomRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** Complete readonly native evidence. The native candidate flag remains unqualified. */
export interface NativeDomGeometry {
  readonly format: "native_dom_geometry_v1";
  readonly status: "ok";
  readonly mode: "native_element_geometry";
  readonly ref: string;
  readonly source_ref: string;
  readonly target_id: string;
  readonly tab_id: string;
  readonly source: Readonly<{ frame_id: string; loader_id: string; backend_node_id: number; context_unique_id: string; generation: number }>;
  readonly frame: Readonly<{ kind: "main" }>;
  readonly css_sample: Readonly<{ connected: true; same_document: true; bounds: NativeDomRect; scroll: Readonly<{ x: number; y: number }>;
    layout_viewport: Readonly<{ width: number; height: number; dpr: number }>;
    visual_viewport: Readonly<{ offset_x: number; offset_y: number; page_x: number; page_y: number; width: number; height: number; scale: number }> }>;
  readonly native: Readonly<{ platform: "windows"; pid: number; window_id: number; window: NativeDomRect; viewport: NativeDomRect;
    source: "uia_root_web_area"; automation_id: "RootWebArea"; framework: "Chrome"; opaque_runtime_id: readonly number[] }>;
  readonly physical_enclosing_rect: NativeDomRect;
  readonly clipped: false;
  readonly coordinate_space: "screen_physical_pixels";
  readonly browser_version: Readonly<{ product: string; revision: string }>;
  readonly projection: "root_origin_plus_floor_start_ceil_end_at_sampled_dpr";
  readonly qualification: "candidate_not_raster_qualified";
  readonly atomic: false;
  readonly input_authority: false;
}
/** Byte-checked native runtime identity, supplied by trusted runtime selection rather than a tool argument. */
export interface NativeDomRuntimeIdentity { readonly source: string; readonly sha256: string }
/** Explicit tested raster scope. Its existence does not adopt a runtime or qualify other browsers/DPRs. */
export interface NativeDomRasterQualification {
  readonly runtime: NativeDomRuntimeIdentity;
  readonly browser: Readonly<{ product: string; revision: string }>;
  readonly dpr: number;
}
/** Closed capture delivery metadata; timestamps do not establish compositor paint freshness. */
export interface NativeDomCaptureMetadata {
  readonly backend: "wgc";
  readonly paint_freshness: "unverified";
  readonly frame_bounds: NativeDomRect;
  readonly wait_ms: number;
  readonly readback_ms: number;
  readonly dequeue_to_copy_ms: number;
  readonly reported_frame_age_at_copy_ms: number;
  readonly frame_timestamp_100ns: number;
  readonly dequeued_100ns: number;
  readonly copy_completed_100ns: number;
  readonly frame_after_request_ms: number;
  readonly discarded: number;
  readonly recreations: number;
  readonly resources_reused: boolean;
  readonly setup_ms: number;
}
/** Fresh native lossless crop. It never becomes an ordinary observation or a from_zoom input context. */
export interface NativeDomCrop {
  readonly kind: "wgc_crop_v1";
  readonly pid: number;
  readonly window_id: number;
  readonly coordinate_space: "screen_physical";
  readonly frame_bounds: NativeDomRect;
  readonly source_dimensions: Readonly<{ width: number; height: number }>;
  readonly crop_bounds: NativeDomRect;
  readonly crop_offset: Readonly<{ x: number; y: number }>;
  readonly width: number;
  readonly height: number;
  readonly format: "png";
  readonly mime_type: "image/png";
  readonly scale: 1;
  readonly padding: 0;
  readonly input_authority: false;
  readonly paint_freshness: "unverified";
  readonly capture_metadata: NativeDomCaptureMetadata;
}

/** Require the explicit native geometry and WGC-only crop schemas before enabling a pinned raster profile. */
export function hasNativeDomRasterSchemas(tools: readonly { name: string; inputSchema: unknown }[]): boolean {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const schema = (name: string) => {
    const matches = tools.filter(tool => tool.name === name);
    return matches.length === 1 ? record(matches[0].inputSchema) : {};
  };
  const browser = schema("get_browser_state"), zoom = schema("zoom"), fields = record(zoom.properties);
  const native = record(record(browser.properties).native_geometry_ref), backend = record(fields.capture_backend);
  const required = zoom.required, pid = record(fields.pid), window = record(fields.window_id);
  const modes = backend.enum;
  // Legacy zoom allows fractional image edges. WGC's stricter integer/target/session
  // admission stays in the native request validator, not an incompatible top-level allOf.
  return browser.type === "object" && native.type === "string" && native.minLength === 1 && native.maxLength === 256 &&
    zoom.type === "object" && zoom.additionalProperties === false && backend.type === "string" &&
    Array.isArray(modes) && modes.length === 2 && ["default", "wgc"].every(value => modes.includes(value)) &&
    Array.isArray(required) && ["window_id", "x1", "y1", "x2", "y2"].every(field => required.includes(field)) &&
    !["allOf", "anyOf", "oneOf"].some(key => Object.hasOwn(zoom, key)) &&
    pid.type === "integer" && pid.minimum === 1 && pid.maximum === 2147483647 && window.type === "integer" && window.minimum === 1 &&
    ["x1", "y1", "x2", "y2"].every(field => record(fields[field]).type === "number");
}
const RECT = ["x", "y", "width", "height"];
const LIMIT = 1_000_000_000;
const MAX_PIXELS = 16_000_000;
function check(condition: unknown): asserts condition {
  if (!condition) throw Error("Native DOM geometry/crop evidence is unavailable, changed or outside its explicit qualification. No pixel fallback.");
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const raw = value as Record<string, unknown>;
  check(Object.keys(raw).length === fields.length && fields.every(field => Object.hasOwn(raw, field)));
  return raw;
}
function budget(value: unknown): void {
  check(Buffer.byteLength(JSON.stringify(value), "utf8") <= 16_384);
}
function text(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && !value.includes("\0");
}
function finite(value: unknown, minimum = -LIMIT, maximum = LIMIT): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function integer(value: unknown, minimum = -LIMIT, maximum = LIMIT): value is number {
  return finite(value, minimum, maximum) && Number.isSafeInteger(value);
}
function numbers(value: unknown, fields: readonly string[]): Record<string, number> {
  const raw = object(value, fields); check(Object.values(raw).every(value => finite(value)));
  return raw as Record<string, number>;
}
function rect(value: unknown, physical: boolean): NativeDomRect {
  const r = numbers(value, RECT);
  check(r.width > 0 && r.height > 0 && finite(r.x + r.width) && finite(r.y + r.height));
  if (physical) check(Object.values(r).every(value => integer(value)));
  return r as unknown as NativeDomRect;
}
function contains(outer: NativeDomRect, inner: NativeDomRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
function same(left: unknown, right: unknown): void { check(isDeepStrictEqual(left, right)); }
function source(value: unknown): void {
  const r = object(value, ["source", "sha256"]);
  check(typeof r.source === "string" && /^[a-f0-9]{40}$/.test(r.source) && typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256));
}

/** Validate a complete exact-source main/open-shadow native geometry reply without promoting its candidate flag. */
export function validateNativeDomGeometry(value: unknown, binding: DomBinding, reference: string, target: WindowTarget): NativeDomGeometry {
  budget(value);
  const raw = object(value, ["format", "status", "mode", "ref", "source_ref", "target_id", "tab_id", "source", "frame", "css_sample", "native",
    "physical_enclosing_rect", "clipped", "coordinate_space", "browser_version", "projection", "qualification", "atomic", "input_authority"]);
  check(text(binding.target_id, 128) && text(binding.tab_id, 128) && text(reference, 128) && /^p[0-9]+:[0-9]+$/.test(reference) &&
    integer(target.pid, 1, 0xffff_ffff) && integer(target.window_id, 1, Number.MAX_SAFE_INTEGER));
  check(raw.format === "native_dom_geometry_v1" && raw.status === "ok" && raw.mode === "native_element_geometry" &&
    raw.ref === reference && raw.source_ref === reference && raw.target_id === binding.target_id && raw.tab_id === binding.tab_id);
  const identity = object(raw.source, ["frame_id", "loader_id", "backend_node_id", "context_unique_id", "generation"]);
  check(text(identity.frame_id) && text(identity.loader_id) && text(identity.context_unique_id, 512) &&
    integer(identity.backend_node_id, 1, Number.MAX_SAFE_INTEGER) && integer(identity.generation, 0, Number.MAX_SAFE_INTEGER));
  check(object(raw.frame, ["kind"]).kind === "main" && raw.clipped === false && raw.coordinate_space === "screen_physical_pixels" &&
    raw.projection === "root_origin_plus_floor_start_ceil_end_at_sampled_dpr" && raw.qualification === "candidate_not_raster_qualified" &&
    raw.atomic === false && raw.input_authority === false);
  const version = object(raw.browser_version, ["product", "revision"]); check(text(version.product) && text(version.revision));
  const native = object(raw.native, ["platform", "pid", "window_id", "window", "viewport", "source", "automation_id", "framework", "opaque_runtime_id"]);
  check(native.platform === "windows" && native.pid === target.pid && native.window_id === target.window_id && native.source === "uia_root_web_area" &&
    native.automation_id === "RootWebArea" && native.framework === "Chrome" && Array.isArray(native.opaque_runtime_id) &&
    native.opaque_runtime_id.length > 0 && native.opaque_runtime_id.length <= 64 && native.opaque_runtime_id.every(value => integer(value, -0x8000_0000, 0x7fff_ffff)));
  const window = rect(native.window, true), viewport = rect(native.viewport, true), physical = rect(raw.physical_enclosing_rect, true);
  check(contains(window, viewport) && contains(viewport, physical));
  const css = object(raw.css_sample, ["connected", "same_document", "bounds", "scroll", "layout_viewport", "visual_viewport"]);
  check(css.connected === true && css.same_document === true);
  const bounds = rect(css.bounds, false), scroll = numbers(css.scroll, ["x", "y"]), layout = numbers(css.layout_viewport, ["width", "height", "dpr"]);
  const visual = numbers(css.visual_viewport, ["offset_x", "offset_y", "page_x", "page_y", "width", "height", "scale"]);
  check(integer(layout.width, 1) && integer(layout.height, 1) && finite(layout.dpr, 0.25, 8) &&
    layout.width * layout.dpr === viewport.width && layout.height * layout.dpr === viewport.height &&
    visual.scale === 1 && visual.offset_x === 0 && visual.offset_y === 0 && visual.page_x === scroll.x && visual.page_y === scroll.y &&
    visual.width > 0 && visual.height > 0);
  const x = Math.floor(bounds.x * layout.dpr), y = Math.floor(bounds.y * layout.dpr);
  same(physical, { x: viewport.x + x, y: viewport.y + y,
    width: Math.ceil((bounds.x + bounds.width) * layout.dpr) - x, height: Math.ceil((bounds.y + bounds.height) * layout.dpr) - y });
  return structuredClone(raw) as unknown as NativeDomGeometry;
}

/** Compare ready source/layout/native samples, not ephemeral per-call isolated-world labels.
 * Each native invocation attests its own context and brackets it with frame/loader/source checks.
 * A different context_unique_id is not a different document; all other evidence must stay equal.
 */
export function assertNativeDomGeometryContinuity(before: NativeDomGeometry, after: NativeDomGeometry): void {
  const stable = (value: NativeDomGeometry) => {
    const checked = validateNativeDomGeometry(value, value, value.ref, value.native);
    const { context_unique_id: _context, ...identity } = checked.source;
    return { ...checked, source: identity };
  };
  same(stable(before), stable(after));
}

/** Require an explicit trusted byte-qualified runtime and exactly tested browser/DPR before releasing any native crop pixels. */
export function assertNativeDomRasterQualification(geometry: NativeDomGeometry, qualification: NativeDomRasterQualification | undefined,
  runtime: NativeDomRuntimeIdentity | undefined): void {
  const sample = validateNativeDomGeometry(geometry, geometry, geometry.ref, geometry.native);
  const q = object(qualification, ["runtime", "browser", "dpr"]);
  source(q.runtime); source(runtime); same(q.runtime, runtime);
  const browser = object(q.browser, ["product", "revision"]); check(text(browser.product) && text(browser.revision));
  same(browser, sample.browser_version); check(q.dpr === sample.css_sample.layout_viewport.dpr);
}

/** Validate one fresh native WGC crop and original PNG header before forwarding pixels. No clipping, resampling, padding or input authority is admitted. */
export function validateNativeDomCrop(value: unknown, image: Content, geometry: NativeDomGeometry,
  qualification: NativeDomRasterQualification | undefined, runtime: NativeDomRuntimeIdentity | undefined): NativeDomCrop {
  assertNativeDomRasterQualification(geometry, qualification, runtime);
  budget(value);
  const raw = object(value, ["kind", "pid", "window_id", "coordinate_space", "frame_bounds", "source_dimensions", "crop_bounds", "crop_offset", "width", "height",
    "format", "mime_type", "scale", "padding", "input_authority", "paint_freshness", "capture_metadata"]);
  check(raw.kind === "wgc_crop_v1" && raw.pid === geometry.native.pid && raw.window_id === geometry.native.window_id && raw.coordinate_space === "screen_physical" &&
    raw.format === "png" && raw.mime_type === "image/png" && raw.scale === 1 && raw.padding === 0 && raw.input_authority === false && raw.paint_freshness === "unverified");
  const frame = rect(raw.frame_bounds, true), crop = rect(raw.crop_bounds, true);
  check(frame.width * frame.height <= MAX_PIXELS && contains(geometry.native.window, frame) && contains(frame, geometry.native.viewport) && contains(frame, crop));
  same(crop, geometry.physical_enclosing_rect);
  const dimensions = numbers(raw.source_dimensions, ["width", "height"]), offset = numbers(raw.crop_offset, ["x", "y"]);
  same(dimensions, { width: frame.width, height: frame.height }); same(offset, { x: crop.x - frame.x, y: crop.y - frame.y });
  check(raw.width === crop.width && raw.height === crop.height && crop.width * crop.height <= MAX_PIXELS);
  const metadata = object(raw.capture_metadata, ["backend", "paint_freshness", "frame_bounds", "wait_ms", "readback_ms", "dequeue_to_copy_ms", "reported_frame_age_at_copy_ms",
    "frame_timestamp_100ns", "dequeued_100ns", "copy_completed_100ns", "frame_after_request_ms", "discarded", "recreations", "resources_reused", "setup_ms"]);
  check(metadata.backend === "wgc" && metadata.paint_freshness === "unverified" && typeof metadata.resources_reused === "boolean");
  same(rect(metadata.frame_bounds, true), frame);
  for (const field of ["wait_ms", "readback_ms", "dequeue_to_copy_ms", "setup_ms"]) check(finite(metadata[field], 0));
  check(finite(metadata.reported_frame_age_at_copy_ms) && finite(metadata.frame_after_request_ms, Number.MIN_VALUE) &&
    integer(metadata.discarded, 0) && integer(metadata.recreations, 0, 3));
  const frameTime = metadata.frame_timestamp_100ns, dequeued = metadata.dequeued_100ns, completed = metadata.copy_completed_100ns;
  check(integer(frameTime, 0, Number.MAX_SAFE_INTEGER) && integer(dequeued, 0, Number.MAX_SAFE_INTEGER) && integer(completed, dequeued, Number.MAX_SAFE_INTEGER) &&
    metadata.dequeue_to_copy_ms === (completed - dequeued) / 10_000 && metadata.reported_frame_age_at_copy_ms === (completed - frameTime) / 10_000);
  object(image, ["type", "mimeType", "data"]);
  check(image.type === "image" && image.mimeType === "image/png" && typeof image.data === "string" && image.data.length > 0 && image.data.length <= 90_000_000 &&
    image.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data));
  const bytes = Buffer.from(image.data, "base64");
  check(bytes.length >= 33 && bytes.length <= 64 * 1024 * 1024 && bytes.toString("base64") === image.data &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) === crop.width && bytes.readUInt32BE(20) === crop.height);
  return structuredClone(raw) as unknown as NativeDomCrop;
}
