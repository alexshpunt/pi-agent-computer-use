import sharp from "sharp";

/** Decoded RGBA pixels of one window overview capture. */
export interface PixelFrame { width: number; height: number; data: Buffer }
export interface PixelBox { x: number; y: number; width: number; height: number }
/** One changed area of the window: nearby changed spots merged, with the number of its changed pixels. */
export interface PixelArea extends PixelBox { pixels: number; /** The input point of the action lies in this area. */ at_input?: true }
/** What a comparison knows about the action: where its input landed and which part of the window shows a web page. */
export interface DiffContext { focus?: { x: number; y: number }; page?: PixelBox }
/** How a window's overview pixels changed between two captures, in overview pixels. */
export interface PixelDiff {
  /** Overview size of both captures; when they differ, `size_changed` holds the earlier size and nothing else is compared. */
  width: number; height: number;
  size_changed?: { width: number; height: number };
  /** Box around every counted change; absent when nothing counted changed. */
  box?: PixelBox;
  /** The changed areas, at most AREA_LIMIT of them: those at or nearest to the input point first, otherwise the largest. */
  areas: PixelArea[];
  /** All changed areas, including any beyond `areas` but not the browser chrome ones. */
  regions: number;
  /** Changes of a browser window outside its web page, such as the tab strip and address bar, summarised. */
  chrome?: { box: PixelBox; regions: number };
  /** Changed pixels that count, and their share of the whole overview. */
  changed_pixels: number; share: number;
  /** Spots too small to count, such as a blinking caret. */
  ignored: number;
}

/** A channel must move by more than this (of 255) for its pixel to count as changed, so compression noise does not. */
const CHANNEL_THRESHOLD = 26;
/** Changed pixels are grouped into spots of touching cells this large. */
const CELL = 8;
/** A spot with fewer changed pixels than this does not count. */
const MIN_SPOT_PIXELS = 12;
/** A spot at most this wide and this tall is caret-shaped (a text cursor blinking) and does not count. */
const CARET_WIDTH = 3, CARET_HEIGHT = 64;
/** Spots closer than this merge into one area, so a stroke drawn in pieces or a repainted label stays one area. */
const AREA_GAP = 24;
const AREA_LIMIT = 8;

export async function decodeFrame(png: Buffer): Promise<PixelFrame> {
  const { data, info } = await sharp(png, { limitInputPixels: 32 * 1024 * 1024 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** Compare two captures of the same window: which pixels changed, where, and how much, ignoring caret-sized spots. */
export function diffFrames(before: PixelFrame, after: PixelFrame, context: DiffContext = {}): PixelDiff {
  const { width, height } = after;
  if (before.width !== width || before.height !== height)
    return { width, height, size_changed: { width: before.width, height: before.height }, areas: [], regions: 0, changed_pixels: 0, share: 0, ignored: 0 };
  // Settle checks mostly compare identical frames: skip the per-pixel pass for them.
  if (before.data.equals(after.data)) return { width, height, areas: [], regions: 0, changed_pixels: 0, share: 0, ignored: 0 };
  const columns = Math.ceil(width / CELL), rows = Math.ceil(height / CELL);
  // Per cell: changed pixel count and the exact box of its changed pixels.
  const count = new Uint32Array(columns * rows);
  const left = new Int32Array(columns * rows).fill(width), top = new Int32Array(columns * rows).fill(height);
  const right = new Int32Array(columns * rows).fill(-1), bottom = new Int32Array(columns * rows).fill(-1);
  const a = before.data, b = after.data;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4, cellRow = Math.floor(y / CELL) * columns;
    for (let x = 0; x < width; x++) {
      const i = row + x * 4;
      if (Math.abs(a[i] - b[i]) <= CHANNEL_THRESHOLD && Math.abs(a[i + 1] - b[i + 1]) <= CHANNEL_THRESHOLD && Math.abs(a[i + 2] - b[i + 2]) <= CHANNEL_THRESHOLD) continue;
      const cell = cellRow + Math.floor(x / CELL);
      count[cell]++;
      if (x < left[cell]) left[cell] = x;
      if (x > right[cell]) right[cell] = x;
      if (y < top[cell]) top[cell] = y;
      if (y > bottom[cell]) bottom[cell] = y;
    }
  }
  // Spots are groups of changed cells that touch, including diagonally.
  const seen = new Uint8Array(columns * rows);
  const spots: PixelArea[] = [];
  let ignored = 0;
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || seen[start]) continue;
    const stack = [start]; seen[start] = 1;
    let pixels = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
    while (stack.length) {
      const cell = stack.pop()!;
      pixels += count[cell];
      x0 = Math.min(x0, left[cell]); y0 = Math.min(y0, top[cell]); x1 = Math.max(x1, right[cell]); y1 = Math.max(y1, bottom[cell]);
      const cx = cell % columns, cy = Math.floor(cell / columns);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy, next = ny * columns + nx;
        if (nx < 0 || ny < 0 || nx >= columns || ny >= rows || seen[next] || !count[next]) continue;
        seen[next] = 1; stack.push(next);
      }
    }
    const spot = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels };
    if (pixels < MIN_SPOT_PIXELS || (spot.width <= CARET_WIDTH && spot.height <= CARET_HEIGHT)) { ignored++; continue; }
    spots.push(spot);
  }
  const merged = mergeNearby(spots);
  const changed = merged.reduce((sum, area) => sum + area.pixels, 0);
  const box = merged.length ? merged.map(({ pixels: _, ...area }) => area).reduce(union) : undefined;
  // In a browser window, changes outside the web page (tab strip, address bar, spinner) are summarised, not listed.
  const page = context.page, chromeAreas = page ? merged.filter(area => !intersects(area, page)) : [];
  const areas = page ? merged.filter(area => intersects(area, page)) : merged;
  const focus = context.focus;
  for (const area of areas) if (focus && distance(area, focus) === 0) area.at_input = true;
  // At or nearest to the input point first; otherwise the largest by extent, so a thin stroke across the canvas
  // outranks a denser but small repainted label.
  areas.sort((x, y) => (focus ? distance(x, focus) - distance(y, focus) : 0) || y.width * y.height - x.width * x.height || y.pixels - x.pixels);
  const chrome = chromeAreas.length ? { box: chromeAreas.map(({ pixels: _, ...area }) => area).reduce(union), regions: chromeAreas.length } : undefined;
  return { width, height, ...(box ? { box } : {}), areas: areas.slice(0, AREA_LIMIT), regions: areas.length, ...(chrome ? { chrome } : {}),
    changed_pixels: changed, share: changed / (width * height), ignored };
}

export const pixelsChanged = (diff: PixelDiff) => diff.size_changed !== undefined || diff.box !== undefined;

/** Merge spots whose boxes come within AREA_GAP of each other, until no two areas are that close. */
function mergeNearby(spots: PixelArea[]): PixelArea[] {
  const areas = [...spots];
  const near = (p: PixelBox, q: PixelBox) => p.x - AREA_GAP < q.x + q.width && q.x - AREA_GAP < p.x + p.width && p.y - AREA_GAP < q.y + q.height && q.y - AREA_GAP < p.y + p.height;
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < areas.length && !merged; i++) for (let j = i + 1; j < areas.length; j++) {
      if (!near(areas[i], areas[j])) continue;
      areas[i] = { ...union(areas[i], areas[j]), pixels: areas[i].pixels + areas[j].pixels };
      areas.splice(j, 1); merged = true; break;
    }
  }
  return areas;
}

const intersects = (a: PixelBox, b: PixelBox) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/** How far a point lies from a box, 0 inside it. */
function distance(box: PixelBox, point: { x: number; y: number }): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width - 1)), dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height - 1));
  return Math.hypot(dx, dy);
}

function union(a: PixelBox, b: PixelBox): PixelBox {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Each crop's long edge is at most this many pixels, so a few crops cost little next to a full overview. */
const CROP_EDGE = 512;
/** A small area is enlarged until its crop's long edge reaches this, so a checkbox or a tile is easy to see. */
const CROP_MIN_EDGE = 192;
/** Enlargement never exceeds this factor. */
const CROP_MAX_SCALE = 4;
/** Context kept around a changed area on each side, in overview pixels. */
const CROP_MARGIN = 12;
/** Only the first areas get crops; the rest are listed by their boxes. */
export const CROPPED_AREAS = 3;
/** When at least this share of the window changed, the whole window is shown instead of crops. */
export const MOST_CHANGED = 0.5;
/** Long edge of the overview that outlines and numbers the changed areas. */
const OVERVIEW_EDGE = 640;

/** Before and after PNG crops of the first changed areas with a small margin, enlarged when small and scaled down when large. */
export async function changeCrops(before: Buffer, after: Buffer, diff: PixelDiff): Promise<{ region: PixelBox; scale: number; before: Buffer; after: Buffer }[]> {
  if (diff.size_changed) return [];
  return Promise.all(diff.areas.slice(0, CROPPED_AREAS).map(async area => {
    const x = Math.max(0, area.x - CROP_MARGIN), y = Math.max(0, area.y - CROP_MARGIN);
    const region = { x, y, width: Math.min(diff.width, area.x + area.width + CROP_MARGIN) - x, height: Math.min(diff.height, area.y + area.height + CROP_MARGIN) - y };
    const long = Math.max(region.width, region.height);
    const scale = long < CROP_MIN_EDGE ? Math.min(CROP_MAX_SCALE, Math.floor(CROP_MIN_EDGE / long) || 1) : Math.min(1, CROP_EDGE / long);
    const width = Math.max(1, Math.round(region.width * scale)), height = Math.max(1, Math.round(region.height * scale));
    // Enlarged pixels stay square, so a checkmark is not blurred into its box.
    const crop = (png: Buffer) => sharp(png, { limitInputPixels: 32 * 1024 * 1024 })
      .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
      .resize(width, height, { kernel: scale > 1 ? "nearest" : "lanczos3" }).png().toBuffer();
    const [b, a] = await Promise.all([crop(before), crop(after)]);
    return { region, scale: Math.round(scale * 100) / 100, before: b, after: a };
  }));
}

/** Digits as 3x5 cells, so labels need no font. */
const DIGITS = ["111101101101111", "010110010010111", "111001111100111", "111001111001111", "101101111001001", "111100111001111", "111100111101111", "111001001001001", "111101111101111", "111101111001111"];

/** SVG rectangles drawing a number at (x, y), each cell `cell` pixels. */
function digits(value: number, x: number, y: number, cell: number): string {
  return [...String(value)].map((digit, index) => [...DIGITS[Number(digit)]].map((on, i) => on === "1"
    ? `<rect x="${x + index * 4 * cell + (i % 3) * cell}" y="${y + Math.floor(i / 3) * cell}" width="${cell}" height="${cell}" fill="#fff"/>` : "").join("")).join("");
}

/**
 * The window after the action, scaled to OVERVIEW_EDGE, with each listed changed area outlined and numbered in list
 * order, and the browser chrome changes outlined without a number.
 */
export async function changeOverview(after: Buffer, diff: PixelDiff): Promise<Buffer> {
  const scale = Math.min(1, OVERVIEW_EDGE / Math.max(diff.width, diff.height));
  const width = Math.max(1, Math.round(diff.width * scale)), height = Math.max(1, Math.round(diff.height * scale));
  const box = (b: PixelBox) => ({ x: Math.round(b.x * scale), y: Math.round(b.y * scale), w: Math.max(2, Math.round(b.width * scale)), h: Math.max(2, Math.round(b.height * scale)) });
  const cell = 2, label = (n: number) => String(n).length * 4 * cell + 2 * cell;
  const marks = diff.areas.map((area, i) => {
    const r = box(area), w = label(i + 1), h = 7 * cell;
    // The number sits above the outline, or inside it at the top edge of the image.
    const ly = r.y - h >= 0 ? r.y - h : r.y;
    return `<rect x="${r.x - 1}" y="${r.y - 1}" width="${r.w + 2}" height="${r.h + 2}" fill="none" stroke="#ff1f8f" stroke-width="2"/>`
      + `<rect x="${r.x - 1}" y="${ly}" width="${w}" height="${h}" fill="#ff1f8f"/>${digits(i + 1, r.x - 1 + cell, ly + cell, cell)}`;
  });
  const chrome = diff.chrome ? (() => { const r = box(diff.chrome!.box); return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#ffb000" stroke-width="1" stroke-dasharray="4 3"/>`; })() : "";
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${chrome}${marks.join("")}</svg>`);
  return sharp(after, { limitInputPixels: 32 * 1024 * 1024 }).resize(width, height).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}
