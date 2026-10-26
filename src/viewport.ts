import sharp from "sharp";
import type { PixelBox } from "./pixel-diff.ts";

/**
 * The longest edge of a viewport's image. A larger viewport is scaled down to it; a smaller one keeps the window's own
 * resolution. Models shrink larger images anyway (Claude above 1568 px).
 */
export const VIEWPORT_CAP = 1568;
/** The smallest viewport side, in full-resolution window pixels. */
const MIN_SIDE = 8;

/** A point in pixels of an image. */
export interface Point { x: number; y: number }
/** A named rectangle of a window that the agent reads and acts in. */
export interface Viewport {
  window_ref: string;
  name: string;
  /** In pixels of the window's full-resolution capture, from the window's top-left corner, so it follows the window. */
  rect: PixelBox;
}

/** The size of a viewport's image: its full-resolution size, scaled down to fit VIEWPORT_CAP. Input points on the viewport are its pixels. */
export function viewportImageSize(rect: PixelBox): { width: number; height: number } {
  const scale = Math.min(1, VIEWPORT_CAP / Math.max(rect.width, rect.height));
  return { width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)) };
}

/** Where a point of the viewport's image lies in the window's full-resolution pixels; undefined outside the image. */
export function windowPoint(rect: PixelBox, point: Point): Point | undefined {
  const image = viewportImageSize(rect);
  if (point.x < 0 || point.y < 0 || point.x >= image.width || point.y >= image.height) return undefined;
  return { x: Math.min(rect.x + rect.width - 1, Math.round(rect.x + point.x * rect.width / image.width)),
    y: Math.min(rect.y + rect.height - 1, Math.round(rect.y + point.y * rect.height / image.height)) };
}

/** Where a point in the window's full-resolution pixels lies in the viewport's image. */
export function viewportPoint(rect: PixelBox, point: Point): Point {
  const image = viewportImageSize(rect);
  return { x: (point.x - rect.x) * image.width / rect.width, y: (point.y - rect.y) * image.height / rect.height };
}

/** The part of a viewport inside a window capture of this size; undefined when too little of it is inside. */
export function clipViewport(rect: PixelBox, size: { width: number; height: number }): PixelBox | undefined {
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const width = Math.min(size.width, rect.x + rect.width) - x, height = Math.min(size.height, rect.y + rect.height) - y;
  return width >= MIN_SIDE && height >= MIN_SIDE ? { x, y, width, height } : undefined;
}

/**
 * A viewport rectangle given in pixels of the window's latest image, which can be scaled down from the window's full
 * resolution by `scale` (full-resolution pixels per image pixel on each axis). Missing fields keep `current`.
 */
export function viewportRect(given: Partial<PixelBox>, scale: Point, current?: PixelBox): PixelBox {
  const pick = (key: keyof PixelBox, factor: number) => given[key] !== undefined ? Math.round(given[key]! * factor) : current?.[key];
  const rect = { x: pick("x", scale.x), y: pick("y", scale.y), width: pick("width", scale.x), height: pick("height", scale.y) };
  if (rect.x === undefined || rect.y === undefined || rect.width === undefined || rect.height === undefined)
    throw Error("A new viewport needs x, y, width and height.");
  if (rect.x < 0 || rect.y < 0 || rect.width < MIN_SIDE || rect.height < MIN_SIDE)
    throw Error(`A viewport starts at x, y of 0 or more and is at least ${MIN_SIDE} full-resolution pixels wide and high.`);
  return rect as PixelBox;
}

/** The size of a PNG image. */
export async function pngSize(png: Buffer): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(png).metadata();
  if (!width || !height) throw Error("The window image has no size.");
  return { width, height };
}

/** Cut a viewport's image out of a full-resolution window capture. */
export async function viewportImage(png: Buffer, rect: PixelBox): Promise<Buffer> {
  const { width, height } = viewportImageSize(rect);
  const crop = sharp(png, { limitInputPixels: 32 * 1024 * 1024 }).extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height });
  return (width === rect.width && height === rect.height ? crop : crop.resize(width, height, { kernel: "lanczos3" })).png().toBuffer();
}
