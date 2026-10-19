import { createHash } from "node:crypto";
import sharp from "sharp";
import { DEFAULT_MAX_LONG_EDGE, nativeImageCap } from "./cua-image-settings.ts";
import { imageGuides, guideOptions, type GuideOptions, type ImageGuides, type GuideAnnotation } from "./image-guides.ts";
import { clipRect, screenRect, type ScreenRect } from "./highlight-geometry.ts";
import type { Content } from "./session.ts";

/** A short alias is valid only with its window and observation, never across native rereads. */
export interface UiElement {
  hint: string; element_token: string; index: number | null; parent_hint: string | null;
  role: string | null; name: string | null; value: string | null; text_truncated: boolean;
  enabled: boolean | null; selected: boolean | null; actions: string[]; depth: number | null;
  bounds: { native_screen?: ScreenRect; window_image?: ScreenRect };
  hint_display: "pending" | "shown" | "disabled" | "no_bounds" | "outside_image" | "collision" | "off";
}
/** Bounded native UIA projection. Completeness is not inferred from an empty search. */
export interface UiResource {
  window_ref: string; observation_id: string; snapshot_id: unknown; captured_at: string;
  complete: boolean | null; truncated: boolean; truncation_reason: unknown;
  native_total: number | null; collected: number; matches: number; projection_truncated: boolean;
  elements: UiElement[];
}
/** Fresh window parts. WGC is Windows-only opt-in on a qualified runtime; default preserves native routing. */
export interface UiCaptureOptions { backend?: "default" | "wgc"; granularity?: "image" | "ui" | "full"; maxLongEdge?: number; scale?: number; max_elements?: number; max_depth?: number; hints?: boolean; guides?: GuideOptions }
/** Read-only operations on one current snapshot; crop consumes its input authority. */
export interface UiRequest {
  operation: "search" | "scope" | "inspect" | "highlight" | "crop" | "region";
  observation_id: string; hint?: string; query?: string; role?: string; limit?: number; region?: ScreenRect;
}
const text = (value: unknown) => typeof value === "string" ? value.slice(0, 1024) : null;
const index = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const bool = (value: unknown) => typeof value === "boolean" ? value : null;
const rect = (value: unknown): ScreenRect | undefined => {
  const f = value as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | undefined;
  return f ? screenRect({ x: f.x, y: f.y, width: f.w, height: f.h }) : undefined;
};
function letters(n: number): string {
  let out = "";
  do { out = String.fromCharCode(97 + n % 26) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

/** Issue a short snapshot-local alias shared by UIA and readonly DOM projections. */
export function elementHint(serial: number, index: number): string { return `${serial.toString(36)}:${letters(index)}`; }

/** Validate before a native walk or replacing any active snapshot. */
export function validateUiCapture(options: UiCaptureOptions): void {
  if (Object.keys(options).some(k => !["backend", "granularity", "maxLongEdge", "scale", "max_elements", "max_depth", "hints", "guides"].includes(k)) ||
    (options.backend !== undefined && !["default", "wgc"].includes(options.backend)) ||
    (options.granularity !== undefined && !["image", "ui", "full"].includes(options.granularity)) ||
    (options.max_elements !== undefined && (!Number.isSafeInteger(options.max_elements) || options.max_elements < 1 || options.max_elements > 2000)) ||
    (options.max_depth !== undefined && (!Number.isSafeInteger(options.max_depth) || options.max_depth < 1 || options.max_depth > 50)) ||
    (options.hints !== undefined && typeof options.hints !== "boolean")) throw Error("Capture needs backend default/wgc, granularity image/ui/full, max_elements 1..2000, max_depth 1..50 and boolean hints.");
  if (options.backend === "wgc" && options.granularity === "ui") throw Error("WGC needs an image or full window observation; UI-only never starts pixel capture.");
  if (options.guides !== undefined) guideOptions(options.guides);
  nativeImageCap({ maxLongEdge: options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE, scale: options.scale ?? 1 });
  if (options.granularity === "ui" && (options.maxLongEdge !== undefined || options.scale !== undefined))
    throw Error("UI-only observation has no image size or scale.");
  if (options.granularity === "image" && (options.max_elements !== undefined || options.max_depth !== undefined || options.hints === true))
    throw Error("Image-only observation has no UI walk or element hints.");
  if (options.granularity === "ui" && (options.hints !== undefined || options.guides !== undefined))
    throw Error("UI-only observation has no image hints or guides.");
}

/** Adapt reported properties only. Native bounds are never treated as local image coordinates. */
export function createUiResource(state: Record<string, unknown>, window: string, observation: string, serial: number): UiResource {
  const native = (Array.isArray(state.elements) ? state.elements : []) as Record<string, unknown>[];
  const rows = native.filter(e => typeof e?.element_token === "string");
  const aliases = new Map(rows.map((e, i) => [e.element_index, elementHint(serial, i)] as const).filter(([key]) => index(key) !== null));
  const elements: UiElement[] = rows.map((e, i) => ({
    hint: elementHint(serial, i), element_token: e.element_token as string,
    index: index(e.element_index), parent_hint: aliases.get(e.parent_index) ?? null,
    role: text(e.role), name: text(e.label), value: text(e.value),
    text_truncated: [e.label, e.value].some(v => typeof v === "string" && v.length > 1024),
    enabled: bool(e.enabled), selected: bool(e.selected), depth: index(e.depth),
    actions: (Array.isArray(e.actions) ? e.actions : []).filter((a): a is string => typeof a === "string").slice(0, 32),
    bounds: { ...(rect(e.frame) ? { native_screen: rect(e.frame) } : {}), ...(rect(e.screenshot_frame) ? { window_image: rect(e.screenshot_frame) } : {}) },
    hint_display: e.enabled === false ? "disabled" : rect(e.screenshot_frame) ? "pending" : "no_bounds",
  }));
  return { window_ref: window, observation_id: observation, snapshot_id: state.snapshot_id ?? null,
    captured_at: new Date().toISOString(), complete: state.truncated === true ? false : bool(state.elements_complete),
    truncated: state.truncated === true, truncation_reason: state.truncation_reason ?? null,
    native_total: index(state.total_element_count ?? state.element_count), collected: elements.length,
    matches: elements.length, projection_truncated: false, elements };
}

/** Resolve exactly one alias; labels and temporary element indices are not addresses. */
export function resolveUi(resource: UiResource, hint: string): UiElement {
  const matches = resource.elements.filter(e => e.hint === hint);
  if (matches.length !== 1) throw Error("Unknown, foreign or retired hint. Use a hint from this observation.");
  return matches[0];
}

/** Search/scope only collected nodes. Parent chains are native indexed relationships, not a guessed full tree. */
export function projectUi(resource: UiResource, request: UiRequest): UiResource {
  if (!request || !["search", "scope", "inspect", "highlight", "crop", "region"].includes(request.operation) ||
    Object.keys(request).some(k => !["operation", "observation_id", "hint", "query", "role", "limit", "region"].includes(k)) ||
    (request.limit !== undefined && (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 2000))) throw Error("Invalid bounded UI operation.");
  if (request.observation_id !== resource.observation_id) throw Error("Retired observation. Observe again.");
  if (!["search", "region"].includes(request.operation) && !request.hint) throw Error("This UI operation needs a current hint.");
  if (!["search", "scope"].includes(request.operation) && [request.query, request.role, request.limit].some(v => v !== undefined))
    throw Error("Filters and limits belong to search or scope, not a selected-element operation.");
  if (request.query !== undefined && (typeof request.query !== "string" || request.query.length > 256)) throw Error("UI query must be text up to 256 characters.");
  if (request.role !== undefined && typeof request.role !== "string") throw Error("UI role must be text.");
  if (request.operation === "region") {
    const r = request.region;
    if (request.hint || request.query !== undefined || request.role !== undefined || request.limit !== undefined || !r ||
      Object.keys(r).sort().join(",") !== "height,width,x,y" || ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0) throw Error("Region needs only a finite positive overview rectangle.");
  } else if (request.region !== undefined) throw Error("A rectangle belongs only to the region operation.");
  let rows = resource.elements;
  if (request.hint) {
    const selected = resolveUi(resource, request.hint);
    const hints = new Set([selected.hint]);
    if (["scope", "search"].includes(request.operation)) {
      for (let count = 0; count < rows.length; count++) {
        const before = hints.size;
        for (const e of rows) if (e.parent_hint && hints.has(e.parent_hint)) hints.add(e.hint);
        if (hints.size === before) break;
      }
    }
    rows = rows.filter(e => hints.has(e.hint));
  }
  if (request.query !== undefined) {
    const q = request.query.toLowerCase();
    rows = rows.filter(e => `${e.name ?? ""} ${e.value ?? ""}`.toLowerCase().includes(q));
  }
  if (request.role !== undefined) rows = rows.filter(e => e.role?.toLowerCase() === request.role!.toLowerCase());
  const limit = request.limit ?? 200;
  return structuredClone({ ...resource, matches: rows.length, projection_truncated: rows.length > limit, elements: rows.slice(0, limit) });
}

/** Annotation pixels and exact label placement; they never create input authority. */
export interface UiAnnotation {
  enabled: boolean; selected_hint?: string; labels: { hint: string; region: ScreenRect; target: ScreenRect }[];
  raw: { hash: string; mime: string; bytes: number }; reason?: string;
  guides: GuideAnnotation;
}
const intersects = (a: ScreenRect, b: ScreenRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Mark returned PNG pixels without resize, external resources or changing the raw native bytes. */
export async function annotateUi(image: Content, resource: UiResource, width: number | undefined, height: number | undefined,
  enabled: boolean, selected?: string, obstacles: UiElement[] = resource.elements, guides: ImageGuides = {}): Promise<{ image: Content; annotation: UiAnnotation }> {
  if (image.type !== "image") throw Error("Expected native image.");
  const bytes = Buffer.from(image.data, "base64");
  const annotation: UiAnnotation = { enabled, ...(selected ? { selected_hint: selected } : {}), labels: [],
    raw: { hash: createHash("sha256").update(bytes).digest("hex"), mime: image.mimeType, bytes: bytes.length },
    guides: imageGuides(0, 0, guides, []).metadata };
  const valid = bytes.length <= 12 * 1024 * 1024 && image.mimeType === "image/png" && bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height;
  if (!valid || !width || !height) {
    annotation.reason = "Native PNG geometry is unavailable.";
    for (const e of resource.elements) e.hint_display = e.enabled === false ? "disabled" : e.bounds.window_image ? "off" : "no_bounds";
    return { image, annotation };
  }
  const canvas = { x: 0, y: 0, width, height };
  const protectedRegions = obstacles.flatMap(e => {
    const r = e.bounds.window_image;
    return r && r.width * r.height < width * height / 4 ? [r] : [];
  });
  const svg: string[] = [];
  for (const e of resource.elements) {
    if (!enabled) { e.hint_display = e.enabled === false ? "disabled" : e.bounds.window_image ? "off" : "no_bounds"; continue; }
    if (e.enabled === false) { e.hint_display = "disabled"; continue; }
    const target = clipRect(e.bounds.window_image, canvas);
    if (!target) { e.hint_display = e.bounds.window_image ? "outside_image" : "no_bounds"; continue; }
    if (selected === e.hint) svg.push(`<rect x="${target.x}" y="${target.y}" width="${target.width}" height="${target.height}" fill="none" stroke="#e52678" stroke-width="2"/>`);
    const w = e.hint.length * 8 + 8; const h = 18;
    const candidates = [
      { x: target.x, y: target.y - h - 2 }, { x: target.x, y: target.y + target.height + 2 },
      { x: target.x - w - 2, y: target.y }, { x: target.x + target.width + 2, y: target.y },
    ].map(p => ({ ...p, width: w, height: h }));
    const region = candidates.find(r => r.x >= 0 && r.y >= 0 && r.x + w <= width && r.y + h <= height &&
      !protectedRegions.some(p => intersects(r, p)) && !annotation.labels.some(p => intersects(r, p.region)));
    if (!region) { e.hint_display = "collision"; continue; }
    e.hint_display = "shown";
    annotation.labels.push({ hint: e.hint, region, target });
    const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
    const end = { x: clamp(region.x + w / 2, target.x, target.x + target.width), y: clamp(region.y + h / 2, target.y, target.y + target.height) };
    const start = { x: clamp(end.x, region.x, region.x + w), y: clamp(end.y, region.y, region.y + h) };
    svg.push(`<path d="M${start.x},${start.y} L${end.x},${end.y}" stroke="#6c5100" stroke-width="1"/><rect x="${region.x}" y="${region.y}" width="${w}" height="${h}" rx="3" fill="#ffe36b" stroke="#3c3000"/><text x="${region.x + 4}" y="${region.y + 13}" font-family="monospace" font-size="13" font-weight="bold" fill="#171400">${e.hint}</text>`);
  }
  const drawn = imageGuides(width, height, guides, [...protectedRegions, ...annotation.labels.map(label => label.region)]);
  annotation.guides = drawn.metadata; svg.push(...drawn.svg);
  if (!svg.length) return { image, annotation };
  const marked = await sharp(bytes).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg.join("")}</svg>`) }]).png().toBuffer();
  return { image: { type: "image", mimeType: "image/png", data: marked.toString("base64") }, annotation };
}
