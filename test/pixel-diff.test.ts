import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { changeCrops, decodeFrame, diffFrames, pixelsChanged, type PixelFrame } from "../src/pixel-diff.ts";

const blank = (width = 200, height = 100): PixelFrame => ({ width, height, data: Buffer.alloc(width * height * 4, 255) });
function paint(frame: PixelFrame, x: number, y: number, width: number, height: number, value = 0): PixelFrame {
  const data = Buffer.from(frame.data);
  for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
    const i = (row * frame.width + column) * 4; data[i] = data[i + 1] = data[i + 2] = value;
  }
  return { ...frame, data };
}
const png = (frame: PixelFrame) => sharp(frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } }).png().toBuffer();

describe("diffFrames", () => {
  test("identical captures report no change", () => {
    const diff = diffFrames(blank(), blank());
    expect(pixelsChanged(diff)).toBe(false);
    expect(diff).toMatchObject({ changed_pixels: 0, share: 0, regions: 0 });
  });

  test("a stroke reports its box, its pixels and their share", () => {
    const diff = diffFrames(blank(), paint(blank(), 20, 40, 100, 2));
    expect(diff.box).toEqual({ x: 20, y: 40, width: 100, height: 2 });
    expect(diff.changed_pixels).toBe(200);
    expect(diff.share).toBeCloseTo(200 / 20_000);
    expect(diff.regions).toBe(1);
  });

  test("separate spots count as regions inside one box", () => {
    const after = paint(paint(blank(), 10, 10, 10, 10), 150, 70, 20, 20);
    const diff = diffFrames(blank(), after);
    expect(diff.regions).toBe(2);
    expect(diff.box).toEqual({ x: 10, y: 10, width: 160, height: 80 });
  });

  test("a blinking caret and a few stray pixels do not count", () => {
    const after = paint(paint(blank(), 50, 20, 2, 18), 120, 60, 3, 3);
    const diff = diffFrames(blank(), after);
    expect(pixelsChanged(diff)).toBe(false);
    expect(diff.ignored).toBe(2);
  });

  test("a caret next to typed text is part of that change", () => {
    const after = paint(paint(blank(), 20, 20, 40, 12), 61, 18, 2, 16);
    const diff = diffFrames(blank(), after);
    expect(diff.box).toEqual({ x: 20, y: 18, width: 43, height: 16 });
  });

  test("small colour noise below the threshold does not count", () => {
    const diff = diffFrames(blank(), paint(blank(), 0, 0, 200, 100, 240));
    expect(pixelsChanged(diff)).toBe(false);
  });

  test("a different capture size is reported instead of compared", () => {
    const diff = diffFrames(blank(200, 100), blank(300, 100));
    expect(diff.size_changed).toEqual({ width: 200, height: 100 });
    expect(pixelsChanged(diff)).toBe(true);
  });
});

describe("changeCrops", () => {
  test("crops the changed box with a margin from both captures", async () => {
    const before = blank(), after = paint(blank(), 50, 30, 20, 10);
    const crops = (await changeCrops(await png(before), await png(after), diffFrames(before, after)))!;
    expect(crops.region).toEqual({ x: 38, y: 18, width: 44, height: 34 });
    const a = await decodeFrame(crops.before), b = await decodeFrame(crops.after);
    expect([a.width, a.height, b.width, b.height]).toEqual([44, 34, 44, 34]);
    expect(diffFrames(a, b).box).toEqual({ x: 12, y: 12, width: 20, height: 10 });
  });

  test("large changed areas are scaled down to a bounded crop", async () => {
    const before = blank(1600, 900), after = paint(blank(1600, 900), 0, 0, 1600, 900, 0);
    const crops = (await changeCrops(await png(before), await png(after), diffFrames(before, after)))!;
    const meta = await sharp(crops.after).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(512);
  });
});
