import sharp from "sharp";

/** Decoded RGBA pixels of one window overview capture. */
export interface PixelFrame { width: number; height: number; data: Buffer }
export interface PixelBox { x: number; y: number; width: number; height: number }
/** One changed area of the window: nearby changed spots merged, with the number of its changed pixels. */
export interface PixelArea extends PixelBox { pixels: number }
/** How a window's overview pixels changed between two captures, in overview pixels. */
export interface PixelDiff {
  /** Overview size of both captures; when they differ, `size_changed` holds the earlier size and nothing else is compared. */
  width: number; height: number;
  size_changed?: { width: number; height: number };
  /** Box around every counted change; absent when nothing counted changed. */
  box?: PixelBox;
  /** The largest changed areas by box size, at most AREA_LIMIT of them. */
  areas: PixelArea[];
  /** All changed areas, including any beyond `areas`. */
  regions: number;
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
export function diffFrames(before: PixelFrame, after: PixelFrame): PixelDiff {
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
  // Largest by extent: a thin stroke across the canvas outranks a denser but small repainted label.
  const areas = mergeNearby(spots).sort((x, y) => y.width * y.height - x.width * x.height || y.pixels - x.pixels);
  const changed = areas.reduce((sum, area) => sum + area.pixels, 0);
  const box = areas.length ? areas.map(({ pixels: _, ...area }) => area).reduce(union) : undefined;
  return { width, height, ...(box ? { box } : {}), areas: areas.slice(0, AREA_LIMIT), regions: areas.length, changed_pixels: changed, share: changed / (width * height), ignored };
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

function union(a: PixelBox, b: PixelBox): PixelBox {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Each crop's long edge is at most this many pixels, so a few crops cost little next to a full overview. */
const CROP_EDGE = 512;
/** Context kept around a changed area on each side, in overview pixels. */
const CROP_MARGIN = 12;
/** Only the largest areas get crops; the rest are listed by their boxes. */
export const CROPPED_AREAS = 3;

/** Before and after PNG crops of the largest changed areas with a small margin, scaled down when large. */
export async function changeCrops(before: Buffer, after: Buffer, diff: PixelDiff): Promise<{ region: PixelBox; before: Buffer; after: Buffer }[]> {
  if (diff.size_changed) return [];
  const crop = (png: Buffer, region: PixelBox) => sharp(png, { limitInputPixels: 32 * 1024 * 1024 })
    .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
    .resize(CROP_EDGE, CROP_EDGE, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return Promise.all(diff.areas.slice(0, CROPPED_AREAS).map(async area => {
    const x = Math.max(0, area.x - CROP_MARGIN), y = Math.max(0, area.y - CROP_MARGIN);
    const region = { x, y, width: Math.min(diff.width, area.x + area.width + CROP_MARGIN) - x, height: Math.min(diff.height, area.y + area.height + CROP_MARGIN) - y };
    const [a, b] = await Promise.all([crop(before, region), crop(after, region)]);
    return { region, before: a, after: b };
  }));
}
