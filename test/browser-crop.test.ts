import { expect, test } from "vitest";
import sharp from "sharp";
import { BrowserImagePipeline } from "../src/browser-image-pipeline.ts";
import { VisionImages } from "../src/vision-images.ts";
import type { BrowserResult } from "../src/browser-session.ts";

const source = () => sharp(Buffer.from('<svg width="1200" height="600"><rect width="1200" height="600" fill="white"/><path d="M120 48h240v120H120z" fill="#235"/><text x="130" y="85" font-size="12" fill="white">Original detail 825</text></svg>')).png().toBuffer();
const view = (png: Buffer): BrowserResult => ({ content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }], details: { status: "observed", tab: 1, screenshot: { width: 1200, height: 600 } } });
const pixels = async (result: BrowserResult) => {
  const block = result.content.find(item => item.type === "image")!;
  if (block.type !== "image") throw new Error("Missing image");
  return sharp(Buffer.from(block.data, "base64")).raw().toBuffer();
};

test("saved and nested crops extract the same original rather than enlarging the overview", async () => {
  const images = new VisionImages(); const pipe = new BrowserImagePipeline(images); const png = await source();
  const overview = await pipe.finish(view(png), images.settings());
  const crop = await pipe.crop({ x: 50, y: 20, width: 100, height: 50, maxLongEdge: 1000, scale: 1 });
  const meta = crop.details.agent_image as { source: { hash: string }; output: { width: number; height: number }; origin: { observation: string; raster: unknown }; mapping: unknown };
  expect(meta.source).toEqual((overview.details.agent_image as typeof meta).source);
  expect(meta.output).toMatchObject({ width: 240, height: 120 });
  expect(meta.origin.raster).toEqual({ x: 120, y: 48, width: 240, height: 120 });
  expect(await pixels(crop)).toEqual(await sharp(png).extract({ left: 120, top: 48, width: 240, height: 120 }).raw().toBuffer());
  const nested = await pipe.crop({ x: 20, y: 10, width: 100, height: 50, maxLongEdge: 1000 });
  const next = nested.details.agent_image as typeof meta;
  expect(next.source).toEqual(meta.source); expect(next.origin.observation).toBe(meta.origin.observation);
  expect(next.origin.raster).toEqual({ x: 140, y: 58, width: 100, height: 50 });
  expect(await pixels(nested)).toEqual(await sharp(png).extract({ left: 140, top: 58, width: 100, height: 50 }).raw().toBuffer());
  expect(pipe.begin("act", { click: { x: 50, y: 25 } }).args).toEqual({ click: { x: 190, y: 83 } });
  expect(images.settings()).toEqual({ kernel: "mks2021", maxLongEdge: 500, scale: 1, version: 0 });
});

test("crop scale is local, invalid bounds do not consume the saved image, and originals expire", async () => {
  const images = new VisionImages(); const pipe = new BrowserImagePipeline(images);
  await pipe.finish(view(await source()), images.settings());
  for (const bad of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 499, y: 0, width: 2, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 10, height: 10, scale: 2 }, { x: 0, y: 0, width: 10, height: 10, mode: "yolo" }])
    await expect(pipe.crop(bad)).rejects.toThrow();
  const crop = await pipe.crop({ x: 0, y: 0, width: 500, height: 250, maxLongEdge: 800, scale: 0.5 });
  expect(crop.details.agent_image).toMatchObject({ cap: 400, output: { width: 400, height: 200 } });
  expect(images.settings().maxLongEdge).toBe(500); images.reset();
  await expect(pipe.crop({ x: 0, y: 0, width: 20, height: 20 })).rejects.toThrow(/retained|expired/);
});

test("historical crop after compact input never restores coordinate permission; focus and close retire it", async () => {
  const images = new VisionImages(); const pipe = new BrowserImagePipeline(images);
  await pipe.finish(view(await source()), images.settings());
  pipe.begin("act", { scroll: 10, observe: false });
  await pipe.finish({ content: [], details: { status: "acted", tab: 1 } }, images.settings());
  const crop = await pipe.crop({ x: 0, y: 0, width: 100, height: 50 });
  expect(crop.details.agent_image).toMatchObject({ origin: { kind: "saved_crop", inputReady: false } });
  expect(() => pipe.begin("act", { click: { x: 10, y: 10 } })).toThrow(/fresh/);
  pipe.begin("focus", { tab: 2 });
  await expect(pipe.crop({ x: 0, y: 0, width: 10, height: 10 })).rejects.toThrow(/saved|image/);
  await pipe.finish(view(await source()), images.settings()); pipe.reset();
  await expect(pipe.crop({ x: 0, y: 0, width: 10, height: 10 })).rejects.toThrow();
});
