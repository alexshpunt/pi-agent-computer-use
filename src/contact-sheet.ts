import sharp from "sharp";
import type { SequenceFrame } from "./temporal-capture.ts";

/** A rectangle in a sequence's frame pixels. */
export interface FrameRegion { x: number; y: number; width: number; height: number }
/**
 * How selected frames are returned: one image each (the default), one tiled contact sheet, or one per-pixel
 * maximum or minimum composite. `region` crops every frame first; `maxLongEdge` bounds the returned image.
 */
export interface FrameRendering { as: "sheet" | "max" | "min"; region?: FrameRegion; columns?: number; maxLongEdge?: number }
/** Bounds of a rendered sheet or composite. */
export const RENDER_LIMITS = { columns: 10, maxLongEdge: 4096, defaultLongEdge: 1600 } as const;

/** One rendered image of several frames, with where each frame went. */
export interface RenderedFrames {
  png: Buffer; width: number; height: number;
  /** For a sheet, each tile's frame and place; for a composite, the frames combined. */
  tiles: { index: number; timestamp_ms: number; x: number; y: number; width: number; height: number }[];
  columns?: number; rows?: number;
  /** The crop actually applied to every frame, clipped to the frames. */
  region?: FrameRegion;
}

const LABEL_HEIGHT = 18;

/** Clip a region to a frame; refuses one that misses the frame. */
function clip(region: FrameRegion, width: number, height: number): FrameRegion {
  const x = Math.max(0, region.x), y = Math.max(0, region.y);
  const right = Math.min(width, region.x + region.width), bottom = Math.min(height, region.y + region.height);
  if (right <= x || bottom <= y) throw Error(`The region ${region.x},${region.y} ${region.width}x${region.height} lies outside the ${width}x${height} frames.`);
  return { x, y, width: right - x, height: bottom - y };
}

/** Decode a frame, cropped to the region when one is given. */
async function decode(frame: SequenceFrame, region: FrameRegion | undefined): Promise<{ data: Buffer; width: number; height: number; region?: FrameRegion }> {
  const image = sharp(Buffer.from(frame.image.data, "base64")).removeAlpha();
  const meta = await image.metadata();
  const crop = region ? clip(region, meta.width!, meta.height!) : undefined;
  const { data, info } = await (crop ? image.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }) : image)
    .raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, region: crop };
}

const escape = (value: string) => value.replace(/[<>&]/g, char => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char]!);
/** A dark label strip with the frame's index and time, drawn as SVG text. */
function label(text: string, width: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_HEIGHT}"><rect width="${width}" height="${LABEL_HEIGHT}" fill="#000"/>` +
    `<text x="4" y="13" font-family="sans-serif" font-size="12" fill="#fff">${escape(text)}</text></svg>`);
}

/**
 * Tile the frames in time order, left to right and top to bottom, each above its index/time label. Tiles keep the
 * frames' aspect ratio and shrink together so the sheet's long edge stays within maxLongEdge.
 */
async function sheet(frames: readonly SequenceFrame[], rendering: FrameRendering): Promise<RenderedFrames> {
  const decoded = await Promise.all(frames.map(frame => decode(frame, rendering.region)));
  const cell = { width: Math.max(...decoded.map(d => d.width)), height: Math.max(...decoded.map(d => d.height)) };
  const columns = Math.min(frames.length, rendering.columns ?? Math.ceil(Math.sqrt(frames.length)));
  const rows = Math.ceil(frames.length / columns);
  const limit = rendering.maxLongEdge ?? RENDER_LIMITS.defaultLongEdge;
  const scale = Math.min(1, limit / Math.max(columns * cell.width, rows * (cell.height + LABEL_HEIGHT)));
  const tile = { width: Math.max(1, Math.floor(cell.width * scale)), height: Math.max(1, Math.floor(cell.height * scale)) };
  const width = columns * tile.width, height = rows * (tile.height + LABEL_HEIGHT);
  const tiles = frames.map((frame, i) => ({ index: frame.index, timestamp_ms: frame.timestamp_ms, x: (i % columns) * tile.width,
    y: Math.floor(i / columns) * (tile.height + LABEL_HEIGHT) + LABEL_HEIGHT, width: tile.width, height: tile.height }));
  const layers = await Promise.all(decoded.map(async (d, i) => {
    const png = await sharp(d.data, { raw: { width: d.width, height: d.height, channels: 3 } })
      .resize(tile.width, tile.height, { fit: "contain", background: "#202020", kernel: "lanczos3" }).png().toBuffer();
    const { x, y } = tiles[i];
    return [{ input: label(`#${frames[i].index} · ${Math.round(frames[i].timestamp_ms)} ms`, tile.width), left: x, top: y - LABEL_HEIGHT },
      { input: png, left: x, top: y }];
  }));
  const png = await sharp({ create: { width, height, channels: 3, background: "#202020" } }).composite(layers.flat()).png().toBuffer();
  return { png, width, height, tiles, columns, rows, ...(decoded[0].region ? { region: decoded[0].region } : {}) };
}

/** The per-pixel maximum or minimum of the frames; every frame must have the same size. */
async function composite(frames: readonly SequenceFrame[], rendering: FrameRendering): Promise<RenderedFrames> {
  const decoded = await Promise.all(frames.map(frame => decode(frame, rendering.region)));
  const { width, height } = decoded[0];
  if (decoded.some(d => d.width !== width || d.height !== height))
    throw Error("A max or min composite needs frames of one size; the window changed size during the sequence. Select frames of one size or use a sheet.");
  const result = Buffer.from(decoded[0].data);
  const pick = rendering.as === "max" ? Math.max : Math.min;
  for (const d of decoded.slice(1)) for (let i = 0; i < result.length; i++) result[i] = pick(result[i], d.data[i]);
  let image = sharp(result, { raw: { width, height, channels: 3 } });
  const limit = rendering.maxLongEdge ?? RENDER_LIMITS.maxLongEdge;
  if (Math.max(width, height) > limit) image = image.resize({ width: width >= height ? limit : undefined, height: height > width ? limit : undefined, kernel: "lanczos3" });
  const { data: png, info } = await image.png().toBuffer({ resolveWithObject: true });
  return { png, width: info.width, height: info.height, tiles: frames.map(frame => ({ index: frame.index, timestamp_ms: frame.timestamp_ms, x: 0, y: 0, width: info.width, height: info.height })),
    ...(decoded[0].region ? { region: decoded[0].region } : {}) };
}

/** Render selected frames as one sheet or composite image. */
export function renderFrames(frames: readonly SequenceFrame[], rendering: FrameRendering): Promise<RenderedFrames> {
  if (!frames.length) throw Error("No frames were selected.");
  return rendering.as === "sheet" ? sheet(frames, rendering) : composite(frames, rendering);
}

/** Validate rendering options of a frames view before any frame is read. */
export function validateRendering(raw: Record<string, unknown>): FrameRendering | undefined {
  if (raw.as === undefined || raw.as === "frames") {
    if (["region", "columns", "maxLongEdge"].some(key => raw[key] !== undefined)) throw Error("region, columns and maxLongEdge apply to as:\"sheet\", \"max\" or \"min\".");
    return undefined;
  }
  if (raw.as !== "sheet" && raw.as !== "max" && raw.as !== "min") throw Error("as is frames (one image each), sheet (one tiled image), max or min (one per-pixel composite).");
  const rendering: FrameRendering = { as: raw.as };
  if (raw.region !== undefined) {
    const region = raw.region as Record<string, unknown>;
    if (!region || typeof region !== "object" || Array.isArray(region) || Object.keys(region).some(key => !["x", "y", "width", "height"].includes(key)) ||
      !["x", "y"].every(key => Number.isSafeInteger(region[key]) && (region[key] as number) >= 0) ||
      !["width", "height"].every(key => Number.isSafeInteger(region[key]) && (region[key] as number) >= 1))
      throw Error("region is {x,y,width,height} in the sequence's frame pixels: x, y >= 0, width, height >= 1.");
    rendering.region = region as unknown as FrameRegion;
  }
  if (raw.columns !== undefined) {
    if (raw.as !== "sheet" || !Number.isSafeInteger(raw.columns) || (raw.columns as number) < 1 || (raw.columns as number) > RENDER_LIMITS.columns)
      throw Error(`columns (1..${RENDER_LIMITS.columns}) applies to a sheet.`);
    rendering.columns = raw.columns as number;
  }
  if (raw.maxLongEdge !== undefined) {
    if (!Number.isSafeInteger(raw.maxLongEdge) || (raw.maxLongEdge as number) < 64 || (raw.maxLongEdge as number) > RENDER_LIMITS.maxLongEdge)
      throw Error(`maxLongEdge is 64..${RENDER_LIMITS.maxLongEdge}.`);
    rendering.maxLongEdge = raw.maxLongEdge as number;
  }
  return rendering;
}
