import sharp from "sharp";
import { expect, test } from "vitest";
import { VisionImages, visionKernels } from "../src/vision-images.ts";
import { BrowserImagePipeline } from "../src/browser-image-pipeline.ts";
import type { BrowserResult } from "../src/browser-session.ts";

const source = async (width = 1200, height = 600) => (await sharp(Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><text x="33" y="45" font-size="17">A sharp diagonal and text</text><path d="M0 0 L${width} ${height}" stroke="black"/></svg>`)).png().toBuffer()).toString("base64");
const view = (png: string, region?: object): BrowserResult => ({ content: [{ type: "image", data: png, mimeType: "image/png" }], details: { status: "observed", tab: 1, screenshot: { width: 1200, height: 600 }, ...(region ? { image_region: region } : {}) } });

test("four kernels produce actual bounded PNGs from the retained original, never CSS-only or upsampling", async () => {
  const images = new VisionImages(); const png = await source();
  expect(images.settings()).toMatchObject({ maxLongEdge: 500, scale: 1, kernel: "mks2021", version: 0 });
  const hashes = new Set<string>();
  for (const kernel of visionKernels) {
    const config = images.update({ kernel, maxLongEdge: 800, scale: 0.5 });
    const result = await images.process(png, config);
    expect(await sharp(Buffer.from(result.png, "base64")).metadata()).toMatchObject({ width: 400, height: 200, format: "png" });
    expect(result.metadata).toMatchObject({ configuration: config, cap: 400, source: { width: 1200, height: 600 }, output: { width: 400, height: 200 }, mapping: { offsetX: 0, offsetY: 0, scaleX: 3, scaleY: 3 } });
    expect(images.asset(result.metadata.source.hash)?.toString("base64")).toBe(png);
    hashes.add(result.metadata.output.hash);
  }
  expect(hashes.size).toBe(4);
  const small = await images.process(await source(40, 20), images.settings());
  expect(small.metadata.output).toMatchObject({ width: 40, height: 20 });
});

test("invalid updates are atomic and a captured configuration does not change mid-flight", async () => {
  const images = new VisionImages(); const captured = images.settings();
  for (const bad of [{ kernel: "fake", maxLongEdge: 800, scale: 1 }, { kernel: "mitchell", maxLongEdge: 0, scale: 1 }, { kernel: "mitchell", maxLongEdge: 800, scale: NaN }, { kernel: "mitchell", maxLongEdge: 800, scale: 1, mode: "yolo" }]) {
    expect(() => images.update(bad)).toThrow(); expect(images.settings()).toEqual(captured);
  }
  images.update({ kernel: "mitchell", maxLongEdge: 1600, scale: 0.5 });
  const result = await images.process(await source(), captured);
  expect(result.metadata.configuration).toEqual(captured);
  expect(result.metadata.output.width).toBe(500);
  expect(images.settings()).toMatchObject({ version: 1, maxLongEdge: 1600 });
  images.reset(); expect(images.asset(result.metadata.source.hash)).toBeUndefined(); expect(images.settings()).toEqual(captured);
});

test("point mapping uses CSS geometry even when the PNG has an extra raster pixel", async () => {
  const images = new VisionImages(); const pipe = new BrowserImagePipeline(images);
  await pipe.finish(view(await source(1201, 601)), images.settings());
  expect(pipe.begin("act", { click: { x: 250, y: 125 } }).args).toEqual({ click: { x: 600, y: 300 } });
  await pipe.finish(view(await source(201, 121), { x: 100, y: 70, width: 200, height: 120 }), images.settings());
  expect(pipe.begin("act", { click: { x: 100.5, y: 60.5 } }).args).toEqual({ click: { x: 200, y: 130 } });
});
test("scaled full-frame and crop clicks map back to source pixels; compact or uncertain results retire the mapping", async () => {
  const images = new VisionImages(); images.update({ kernel: "lanczos3", maxLongEdge: 800, scale: 0.5 });
  const pipe = new BrowserImagePipeline(images);
  const config = pipe.begin("open", { url: "https://example.test" }).configuration;
  const result = await pipe.finish(view(await source()), config);
  expect(result.details.agent_image).toMatchObject({ output: { width: 400, height: 200 } });
  expect(pipe.begin("act", { click: { x: 200, y: 100 }, observe: false }).args).toEqual({ click: { x: 600, y: 300 }, observe: false });
  await pipe.finish({ content: [], details: { status: "acted", tab: 1 } }, images.settings());
  expect(() => pipe.begin("act", { click: { x: 1, y: 1 } })).toThrow("fresh");
  await pipe.finish(view(await source(800, 400), { x: 100, y: 70, width: 800, height: 400 }), images.settings());
  expect(pipe.begin("act", { move: { x: 200, y: 100 } }).args).toEqual({ move: { x: 500, y: 270 } });
  await pipe.finish(view(await source()), images.settings());
  expect(() => pipe.begin("act", { click: { x: 400, y: 0 } })).toThrow("bounds");
  await pipe.finish({ content: [], details: { status: "unknown" }, isError: true }, images.settings());
  expect(() => pipe.begin("act", { click: { x: 1, y: 1 } })).toThrow("fresh");
});
