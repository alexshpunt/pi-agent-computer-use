import assert from "node:assert/strict";
import sharp from "sharp";

/** Inspect supplied PNG pixels; a JS draw acknowledgement is not a presentation witness. */
export async function inspectMarkerPixels(png: Buffer, color: readonly number[], previousColor?: readonly number[]) {
  assert.ok(color.length === 3 && color.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
  if (previousColor) assert.ok(previousColor.length === 3 && previousColor.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
  const decoded = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.channels, 3, "The marker witness requires RGB pixels");
  let matching = 0, previous = 0;
  for (let p = 0; p < decoded.data.length; p += 3) {
    const r = decoded.data[p], g = decoded.data[p + 1], b = decoded.data[p + 2];
    if (Math.abs(r - color[0]) <= 3 && Math.abs(g - color[1]) <= 3 && Math.abs(b - color[2]) <= 3) matching++;
    if (previousColor && Math.abs(r - previousColor[0]) <= 3 && Math.abs(g - previousColor[1]) <= 3 && Math.abs(b - previousColor[2]) <= 3) previous++;
  }
  return { matching_pixels: matching, previous_matching_pixels: previousColor ? previous : undefined,
    image_width: decoded.info.width, image_height: decoded.info.height };
}
