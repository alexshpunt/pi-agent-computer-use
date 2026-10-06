import { clipRect, type ScreenRect } from "./highlight-geometry.ts";

/** Optional model-facing guides. They never change input coordinates or native image sizing. */
export interface GuideOptions { grid: boolean; region: boolean; action: boolean }
/** Proven image-local geometry, or an explicit explanation of its absence. */
export interface GuideMark { region?: ScreenRect; reason?: string; basis?: string }
/** One snapshot's guide inputs; no pointers or image bytes are retained here. */
export interface ImageGuides { options?: GuideOptions; region?: ScreenRect; action?: GuideMark }
interface GuideResult { status: "off" | "shown" | "unavailable"; reason?: string; region?: ScreenRect; clipped?: boolean; occluded?: boolean; basis?: string }
/** Exact guide placement metadata in returned overview pixels, not a new target space. */
export interface GuideAnnotation {
  grid: GuideResult & { coordinate_space: "window_image_pixels"; step?: number; omitted_labels?: number; labels?: { text: string; region: ScreenRect }[] };
  region: GuideResult; action: GuideResult;
}

/** Strict future-capture tuple; reject partial settings instead of silently enabling a guide. */
export function guideOptions(value: unknown): GuideOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected grid, region and action booleans.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "action,grid,region" || [v.grid, v.region, v.action].some(x => typeof x !== "boolean"))
    throw Error("Expected only grid, region and action booleans.");
  return { grid: v.grid as boolean, region: v.region as boolean, action: v.action as boolean };
}
const overlaps = (a: ScreenRect, b: ScreenRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Build only SVG primitives over native output pixels; controls and existing badges remain clear. */
export function imageGuides(width: number, height: number, guides: ImageGuides, protectedRegions: ScreenRect[]) {
  const options = guides.options;
  const metadata: GuideAnnotation = {
    grid: { status: options?.grid ? "unavailable" : "off", coordinate_space: "window_image_pixels" },
    region: { status: options?.region ? "unavailable" : "off" }, action: { status: options?.action ? "unavailable" : "off" },
  };
  const svg: string[] = [];
  if (width <= 0 || height <= 0) {
    for (const key of ["grid", "region", "action"] as const) if (options?.[key]) metadata[key].reason = "Native PNG geometry is unavailable.";
    return { svg, metadata };
  }
  const bounds = { x: 0, y: 0, width, height };
  // Leave a small gap around control text and anti-aliased badge edges.
  const obstacles = protectedRegions.map(r => ({ x: r.x - 2, y: r.y - 2, width: r.width + 4, height: r.height + 4 }));
  let occlusions = 0;
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, dashed = false) => {
    const vertical = x1 === x2;
    const low = vertical ? Math.min(y1, y2) : Math.min(x1, x2);
    const high = vertical ? Math.max(y1, y2) : Math.max(x1, x2);
    let segments = [[low, high]];
    for (const r of obstacles) {
      const crosses = vertical ? x1 >= r.x && x1 <= r.x + r.width : y1 >= r.y && y1 <= r.y + r.height;
      if (!crosses) continue;
      const a = vertical ? r.y : r.x; const b = a + (vertical ? r.height : r.width);
      segments = segments.flatMap(([start, end]) => {
        if (b <= start || a >= end) return [[start, end]];
        occlusions++;
        return [...(a > start ? [[start, a]] : []), ...(b < end ? [[b, end]] : [])];
      });
    }
    for (const [start, end] of segments) if (end > start) svg.push(`<path d="M${vertical ? x1 : start},${vertical ? start : y1} L${vertical ? x2 : end},${vertical ? end : y2}" fill="none" stroke="${color}" stroke-width="1"${dashed ? ' stroke-dasharray="4 4"' : ""}/>`);
  };
  if (options?.grid) {
    const step = Math.max(50, Math.ceil(Math.max(width, height) / 8 / 50) * 50);
    const labels: { text: string; region: ScreenRect }[] = [];
    let omitted = 0;
    const label = (text: string, x: number, y: number) => {
      const region = { x, y, width: text.length * 7 + 6, height: 16 };
      if (x < 0 || y < 0 || x + region.width > width || y + region.height > height ||
        obstacles.some(r => overlaps(r, region)) || labels.some(r => overlaps(r.region, region))) return false;
      labels.push({ text, region });
      svg.push(`<rect x="${x}" y="${y}" width="${region.width}" height="16" fill="#e7fbff"/><text x="${x + 3}" y="${y + 12}" font-family="monospace" font-size="12" fill="#003940">${text}</text>`);
      obstacles.push(region); return true;
    };
    for (let x = 0; x < width; x += step) if (!label(String(x), x + 3, 2) && !label(String(x), x + 3, height - 18)) omitted++;
    for (let y = step; y < height; y += step) {
      const text = String(y);
      if (!label(text, 2, y + 3) && !label(text, width - (text.length * 7 + 6) - 2, y + 3)) omitted++;
    }
    for (let x = step; x < width; x += step) line(x, 0, x, height - 1, "#549aa8", true);
    for (let y = step; y < height; y += step) line(0, y, width - 1, y, "#549aa8", true);
    metadata.grid = { status: "shown", coordinate_space: "window_image_pixels", step, labels, omitted_labels: omitted, occluded: occlusions > 0 };
  }
  const mark = (key: "region" | "action", value: GuideMark | undefined, color: string) => {
    if (!options?.[key]) return;
    const original = value?.region;
    const region = clipRect(original, bounds);
    if (!region || !original) { metadata[key] = { status: "unavailable", reason: value?.reason ?? (value?.region ? "Region is outside the current image." : "No proven region.") }; return; }
    const before = svg.length; const hidden = occlusions;
    // Borders only: no filled target and no text over its contents.
    const right = Math.min(width - 1, region.x + region.width); const bottom = Math.min(height - 1, region.y + region.height);
    line(region.x, region.y, right, region.y, color); line(right, region.y, right, bottom, color);
    line(region.x, bottom, right, bottom, color); line(region.x, region.y, region.x, bottom, color);
    metadata[key] = { status: svg.length > before ? "shown" : "unavailable", region,
      clipped: original.x < 0 || original.y < 0 || original.x + original.width > width || original.y + original.height > height, occluded: occlusions > hidden, ...(value?.basis ? { basis: value.basis } : {}),
      ...(svg.length === before ? { reason: "Known controls cover the guide border." } : {}) };
  };
  mark("region", guides.region ? { region: guides.region, basis: "selected_overview_region" } : undefined, "#d98400");
  mark("action", guides.action, "#e52678");
  return { svg, metadata };
}
