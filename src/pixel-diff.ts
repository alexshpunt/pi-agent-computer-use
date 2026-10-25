import sharp from "sharp";

/** Decoded RGBA pixels of one window overview capture. */
export interface PixelFrame { width: number; height: number; data: Buffer }
export interface PixelBox { x: number; y: number; width: number; height: number }
/** How a window's overview pixels changed between two captures, in overview pixels. */
export interface PixelDiff {
  /** Overview size of both captures; when they differ, `size_changed` holds the earlier size and nothing else is compared. */
  width: number; height: number;
  size_changed?: { width: number; height: number };
  /** Box around every counted change; absent when nothing counted changed. */
  box?: PixelBox;
  /** Changed pixels that count, and their share of the whole overview. */
  changed_pixels: number; share: number;
  /** Separate changed spots that count. */
  regions: number;
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

export async function decodeFrame(png: Buffer): Promise<PixelFrame> {
  const { data, info } = await sharp(png, { limitInputPixels: 32 * 1024 * 1024 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** Compare two captures of the same window: which pixels changed, where, and how much, ignoring caret-sized spots. */
export function diffFrames(before: PixelFrame, after: PixelFrame): PixelDiff {
  const { width, height } = after;
  if (before.width !== width || before.height !== height)
    return { width, height, size_changed: { width: before.width, height: before.height }, changed_pixels: 0, share: 0, regions: 0, ignored: 0 };
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
  let box: PixelBox | undefined, changed = 0, regions = 0, ignored = 0;
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
    const spot = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    if (pixels < MIN_SPOT_PIXELS || (spot.width <= CARET_WIDTH && spot.height <= CARET_HEIGHT)) { ignored++; continue; }
    regions++; changed += pixels;
    box = box ? union(box, spot) : spot;
  }
  return { width, height, ...(box ? { box } : {}), changed_pixels: changed, share: changed / (width * height), regions, ignored };
}

export const pixelsChanged = (diff: PixelDiff) => diff.size_changed !== undefined || diff.box !== undefined;

function union(a: PixelBox, b: PixelBox): PixelBox {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Each crop's long edge is at most this many pixels, so two crops cost little next to a full overview. */
const CROP_EDGE = 512;
/** Context kept around the changed box on each side, in overview pixels. */
const CROP_MARGIN = 12;

/** Before and after PNG crops of the changed box with a small margin, scaled down when large. */
export async function changeCrops(before: Buffer, after: Buffer, diff: PixelDiff): Promise<{ region: PixelBox; before: Buffer; after: Buffer } | undefined> {
  if (!diff.box || diff.size_changed) return undefined;
  const x = Math.max(0, diff.box.x - CROP_MARGIN), y = Math.max(0, diff.box.y - CROP_MARGIN);
  const region = { x, y, width: Math.min(diff.width, diff.box.x + diff.box.width + CROP_MARGIN) - x, height: Math.min(diff.height, diff.box.y + diff.box.height + CROP_MARGIN) - y };
  const crop = (png: Buffer) => sharp(png, { limitInputPixels: 32 * 1024 * 1024 })
    .extract({ left: region.x, top: region.y, width: region.width, height: region.height })
    .resize(CROP_EDGE, CROP_EDGE, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const [a, b] = await Promise.all([crop(before), crop(after)]);
  return { region, before: a, after: b };
}
