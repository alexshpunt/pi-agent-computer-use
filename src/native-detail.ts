import sharp from "sharp";
import type { Content } from "./session.ts";
import { nativeImageCap } from "./cua-image-settings.ts";
import type { WindowImageMapping } from "./highlight-geometry.ts";

/** A read-only detail rectangle grounded in one returned overview, never in a previous detail. */
export interface DetailRequest { image_id: string; x: number; y: number; width: number; height: number; maxLongEdge?: number; scale?: number }
/** Geometry only. No original pixels are retained between observations. */
export interface DetailContext { id: string; width: number; height: number; originalWidth: number; originalHeight: number; geometry: string; windowMapping?: WindowImageMapping }
/** Integer native-pixel extraction bounds, covering the requested overview rectangle. */
export interface NativeRegion { left: number; top: number; width: number; height: number }

/** Validate the source token and coordinates before any new native capture. */
export function validateDetail(request: DetailRequest, context: DetailContext | undefined, window: boolean): number {
  if (!context || request.image_id !== context.id) throw new Error("Detail needs the latest overview image_id. Observe again; details cannot nest.");
  if (Object.keys(request).some(key => !["image_id", "x", "y", "width", "height", "maxLongEdge", "scale"].includes(key)) ||
    ![request.x, request.y, request.width, request.height].every(Number.isFinite) || request.x < 0 || request.y < 0 || request.width <= 0 || request.height <= 0 ||
    request.x + request.width > context.width || request.y + request.height > context.height)
    throw new Error("Detail rectangle must fit within that overview image.");
  if (window && (request.width > 500 || request.maxLongEdge !== undefined || request.scale !== undefined))
    throw new Error("Window zoom uses CUA's native padding and 500px width limit. Size overrides are display-only.");
  return nativeImageCap({ maxLongEdge: request.maxLongEdge ?? 1200, scale: request.scale ?? 1 });
}

/** Map overview pixels to native pixels once, rounding outwards and never deriving DPI. */
export function nativeRegion(request: DetailRequest, context: DetailContext): NativeRegion {
  const left = Math.floor(request.x * context.originalWidth / context.width);
  const top = Math.floor(request.y * context.originalHeight / context.height);
  const right = Math.min(context.originalWidth, Math.ceil((request.x + request.width) * context.originalWidth / context.width));
  const bottom = Math.min(context.originalHeight, Math.ceil((request.y + request.height) * context.originalHeight / context.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** Crop only a fresh native display PNG. Raw pixels are local to this call; no capture engine or cache is added. */
export async function cropDisplay(image: Extract<Content, { type: "image" }>, context: DetailContext, region: NativeRegion, cap: number) {
  const bytes = Buffer.from(image.data, "base64");
  if (image.mimeType !== "image/png" || bytes.length > 64 * 1024 * 1024 || bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(16) !== context.originalWidth || bytes.readUInt32BE(20) !== context.originalHeight)
    throw new Error("Fresh native display raster does not match the overview geometry.");
  const { data, info } = await sharp(bytes, { limitInputPixels: 32 * 1024 * 1024 })
    .extract(region).resize(cap, cap, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" }).png().toBuffer({ resolveWithObject: true });
  return { image: { type: "image" as const, mimeType: "image/png", data: data.toString("base64") }, width: info.width, height: info.height };
}
