import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { derivedPng } from "../src/web-capture.ts";
import { elementRect, matchesViewport, type PageGeometry } from "../src/web-geometry.ts";

const geometry = (over: Partial<PageGeometry> = {}): PageGeometry => ({ dpr: 1.5, scrollX: 0, scrollY: 0, innerWidth: 200, innerHeight: 100, ...over });
/** A device-pixel viewport screenshot, white with a black block at the given device rectangle. */
async function viewportPng(width: number, height: number, block?: { left: number; top: number; width: number; height: number }): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3, 255);
  if (block) for (let y = block.top; y < block.top + block.height; y++) for (let x = block.left; x < block.left + block.width; x++) data.fill(0, (y * width + x) * 3, (y * width + x) * 3 + 3);
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
const size = async (png: Buffer) => { const { width, height } = await sharp(png).metadata(); return { width, height }; };

describe("matchesViewport", () => {
  test("accepts device pixels of the viewport within a pixel and refuses another scale", () => {
    expect(matchesViewport({ width: 300, height: 150 }, geometry())).toBe(true);
    expect(matchesViewport({ width: 299, height: 151 }, geometry({ innerWidth: 200, innerHeight: 100 }))).toBe(true);
    expect(matchesViewport({ width: 200, height: 100 }, geometry())).toBe(false);
  });
});

describe("elementRect", () => {
  test("covers the integer CSS rectangle around the box, scaled to device pixels", () => {
    expect(elementRect({ x: 10.4, y: 20.2, width: 30.3, height: 10.1 }, geometry(), { width: 300, height: 150 }))
      .toEqual({ left: 15, top: 30, width: 47, height: 17 });
  });

  test("rounds the integer rectangle from page coordinates, not from the scrolled viewport", () => {
    // Page y 50.6..60.7 → 50..61; with scroll 30.3 the viewport top is (50 - 30.3) * 1.5 = 29.55 → 30.
    expect(elementRect({ x: 0, y: 20.3, width: 10, height: 10.1 }, geometry({ scrollY: 30.3 }), { width: 300, height: 150 }))
      .toEqual({ left: 0, top: 30, width: 15, height: 17 });
  });

  test("refuses an element that is not wholly inside the screenshot", () => {
    const image = { width: 300, height: 150 };
    expect(elementRect({ x: -1, y: 5, width: 10, height: 10 }, geometry(), image)).toBeUndefined();
    expect(elementRect({ x: 5, y: 95, width: 10, height: 10 }, geometry(), image)).toBeUndefined();
    expect(elementRect({ x: 5, y: 5, width: 0, height: 10 }, geometry(), image)).toBeUndefined();
  });
});

describe("derivedPng", () => {
  test("cuts an element out of the viewport screenshot pixel for pixel", async () => {
    const png = await viewportPng(300, 150, { left: 15, top: 30, width: 45, height: 15 });
    const element = await derivedPng(png, { geometry: geometry(), box: { x: 10, y: 20, width: 30, height: 10 } });
    expect(await size(element)).toEqual({ width: 45, height: 15 });
    const { data } = await sharp(element).raw().toBuffer({ resolveWithObject: true });
    expect([...new Set(data)]).toEqual([0]);
  });

  test("scales the viewport screenshot to one pixel per CSS pixel", async () => {
    expect(await size(await derivedPng(await viewportPng(300, 150), { geometry: geometry(), css: true }))).toEqual({ width: 200, height: 100 });
  });

  test("fails for an element outside the screenshot instead of returning other pixels", async () => {
    await expect(derivedPng(await viewportPng(300, 150), { geometry: geometry(), box: { x: 190, y: 90, width: 30, height: 30 } }))
      .rejects.toThrow("The element is not inside the page screenshot.");
  });
});
