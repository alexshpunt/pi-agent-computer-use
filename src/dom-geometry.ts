import type { DomBinding } from "./dom-inspection.ts";

/** One readonly CSSOM sample, not native pixels, visibility or atomic paint evidence. */
export interface DomGeometry {
  coordinate_space: "frame_viewport_css_pixels";
  viewport: "layout";
  method: "isolated_cssom_border_box";
  native_pixel_mapping: "unavailable";
  atomic: false;
  connected: true;
  same_document: true;
  bounds: { x: number; y: number; width: number; height: number };
  scroll: { x: number; y: number };
  visual_viewport: { offset_x: number; offset_y: number; page_x: number; page_y: number; width: number; height: number; scale: number };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a CSSOM geometry object.");
  return value as Record<string, unknown>;
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= 128 && !value.includes("\0");
}
function numbers<K extends string>(value: unknown, fields: readonly K[]): Record<K, number> {
  const raw = object(value), result = {} as Record<K, number>;
  for (const field of fields) {
    const number = raw[field];
    check(typeof number === "number" && Number.isFinite(number) && Math.abs(number) <= 1_000_000_000,
      "CSSOM geometry needs finite bounded numbers without unit conversion.");
    result[field] = number;
  }
  return result;
}

/** Validate the exact internal source and strip all native capabilities and unknown metadata.
 * Zero-area rectangles are valid; callers must not infer visibility or pixel/input authority.
 */
export function validateDomGeometry(value: unknown, binding: DomBinding, reference: string): DomGeometry {
  const raw = object(value);
  check(Buffer.byteLength(JSON.stringify(raw), "utf8") <= 16_384, "CSSOM geometry exceeds its native reply budget.");
  check(identity(binding.target_id) && identity(binding.tab_id) && identity(reference) && /^p[0-9]+:[0-9]+$/.test(reference),
    "CSSOM geometry requires a current internal DOM source.");
  check(raw.status === "ok" && raw.mode === "element_geometry" && raw.target_id === binding.target_id &&
    raw.tab_id === binding.tab_id && raw.ref === reference && raw.source_ref === reference,
    "CSSOM geometry changed the admitted target, tab or readonly reference.");
  check(raw.refusal === undefined && raw.error === undefined && raw.exceptionDetails === undefined && raw.wasThrown !== true,
    "A refused or exceptional CSSOM read cannot become geometry.");
  check(object(raw.frame).kind === "main" && raw.coordinate_space === "frame_viewport_css_pixels" && raw.viewport === "layout" &&
    raw.method === "isolated_cssom_border_box" && raw.native_pixel_mapping === "unavailable" && raw.atomic === false &&
    raw.connected === true && raw.same_document === true,
    "CSSOM geometry lacks current main-frame readonly CSS qualification.");
  const bounds = numbers(raw.bounds, ["x", "y", "width", "height"]);
  const scroll = numbers(raw.scroll, ["x", "y"]);
  const visual_viewport = numbers(raw.visual_viewport, ["offset_x", "offset_y", "page_x", "page_y", "width", "height", "scale"]);
  check(bounds.width >= 0 && bounds.height >= 0 && Math.abs(bounds.x + bounds.width) <= 1_000_000_000 &&
    Math.abs(bounds.y + bounds.height) <= 1_000_000_000 && visual_viewport.width > 0 && visual_viewport.height > 0 && visual_viewport.scale > 0,
    "CSSOM geometry dimensions or extents are invalid.");
  return { coordinate_space: "frame_viewport_css_pixels", viewport: "layout", method: "isolated_cssom_border_box",
    native_pixel_mapping: "unavailable", atomic: false, connected: true, same_document: true, bounds, scroll, visual_viewport };
}
