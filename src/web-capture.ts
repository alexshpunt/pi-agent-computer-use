import sharp from "sharp";
import { elementRect, type Derive, type PageGeometry, type PixelRect } from "./web-geometry.ts";

/** A plain viewport PNG cut to one rectangle: what an element screenshot shows. */
export function cropPng(png: Buffer, rect: PixelRect): Promise<Buffer> {
  return sharp(png).extract(rect).png().toBuffer();
}

/** A plain viewport PNG scaled to one image pixel per CSS pixel, within a pixel of the size Chrome's `scale: "css"` gives. */
export function cssPng(png: Buffer, geometry: PageGeometry): Promise<Buffer> {
  return sharp(png).resize(geometry.innerWidth, geometry.innerHeight, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
}

/** The image a worker's plain viewport screenshot stands for: the element's pixels, or the page in CSS pixels. */
export async function derivedPng(png: Buffer, derive: Derive): Promise<Buffer> {
  if (derive.box) {
    const rect = elementRect(derive.box, derive.geometry, { width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
    if (!rect) throw new Error("The element is not inside the page screenshot.");
    return cropPng(png, rect);
  }
  return cssPng(png, derive.geometry);
}
