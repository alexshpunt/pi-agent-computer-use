import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { VisualClassifier, decide } from "../src/visual-classifier.ts";

const image = async () => ({ type: "image" as const, data: (await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } }).png().toBuffer()).toString("base64"), mimeType: "image/png" });

test("one raw score takes exactly one branch; uncertainty includes its boundaries", () => {
  expect(decide(.4, .3, .02)).toBe(true);
  expect(decide(.2, .3, .02)).toBe(false);
  for (const score of [.28, .3, .32]) expect(decide(score, .3, .02)).toBe(null);
  expect(decide(.3, .3, 0)).toBe(null);
  for (const args of [[NaN,.3,0],[.2,Infinity,0],[.2,.99,.1],[.2,.3,-.1]])
    expect(() => decide(...args as [number,number,number])).toThrow();
});

test("the owned worker stays warm, caches one condition, and errors never become false", async () => {
  const classifier = new VisualClassifier({ python: process.execPath, model: "fixture" }, path.resolve("test/fixtures/visual-classifier-worker.mjs"));
  try {
    const pixels = await image();
    const first = await classifier.classify({ image: pixels, condition: "visible", threshold: .3 });
    const second = await classifier.classify({ image: pixels, condition: "visible", threshold: .5, uncertainty: .2 });
    expect(first).toMatchObject({ status: "classified", value: true, score: .4, cache_hit: false });
    expect(second).toMatchObject({ status: "classified", value: null, cache_hit: true });
    await expect(classifier.classify({ image: pixels, condition: "worker error", threshold: .3 })).rejects.toThrow("Fixture error");
    await expect(classifier.classify({ image: pixels, condition: "", threshold: .3 })).rejects.toThrow();
    await expect(classifier.classify({ image: { ...pixels, data: "not base64" }, condition: "visible", threshold: .3 })).rejects.toThrow();
    expect(await classifier.classify({ image: pixels, condition: "another", threshold: .5 })).toMatchObject({ value: false, cache_hit: false });
  } finally { await classifier.close(); }
});

test("an aborted owned request is not replayed and close permits a fresh worker", async () => {
  const classifier = new VisualClassifier({ python: process.execPath, model: "fixture" }, path.resolve("test/fixtures/visual-classifier-worker.mjs"));
  try {
    const pixels = await image(); const abort = new AbortController();
    const pending = classifier.classify({ image: pixels, condition: "wait", threshold: .3 }, abort.signal);
    setTimeout(() => abort.abort(), 100);
    await expect(pending).rejects.toThrow(/abort/i);
    expect(await classifier.classify({ image: pixels, condition: "visible", threshold: .3 })).toMatchObject({ cache_hit: false });
    await classifier.close();
    expect(await classifier.classify({ image: pixels, condition: "visible", threshold: .3 })).toMatchObject({ cache_hit: false });
  } finally { await classifier.close(); }
});

test("close rejects queued work without starting a replacement model", async () => {
  const classifier = new VisualClassifier({ python: process.execPath, model: "fixture" }, path.resolve("test/fixtures/visual-classifier-worker.mjs"));
  const pixels = await image();
  const active = classifier.classify({image:pixels,condition:"wait",threshold:.3});
  const queued = classifier.classify({image:pixels,condition:"visible",threshold:.3});
  const results = Promise.allSettled([active, queued]);
  await new Promise(resolve => setTimeout(resolve,50));
  await classifier.close();
  expect((await results).map(result=>result.status)).toEqual(["rejected","rejected"]);
});

test("overflow and already-aborted work never bypass the bounded queue", async () => {
  const classifier = new VisualClassifier({python:process.execPath,model:"fixture"},path.resolve("test/fixtures/visual-classifier-worker.mjs"));
  const pixels = await image();
  const requests = Array.from({length:8},()=>classifier.classify({image:pixels,condition:"wait",threshold:.3}));
  const joined = Promise.allSettled(requests);
  await expect(classifier.classify({image:pixels,condition:"visible",threshold:.3})).rejects.toThrow(/queue is full/);
  await classifier.close(); expect((await joined).every(result=>result.status==="rejected")).toBe(true);
  const abort = new AbortController(); abort.abort();
  await expect(classifier.classify({image:pixels,condition:"visible",threshold:.3},abort.signal)).rejects.toThrow();
  await classifier.close();
});
test("a missing Python runtime rejects and still closes without a detection", async () => {
  const classifier = new VisualClassifier({python:"/no-such-classifier-python",model:"fixture"});
  await expect(classifier.classify({image:await image(),condition:"visible",threshold:.3})).rejects.toThrow(/Cannot start/);
  await classifier.close();
});
test("a region classifies only its pixels and keeps the source image identity", async () => {
  const classifier = new VisualClassifier({ python: process.execPath, model: "fixture" }, path.resolve("test/fixtures/visual-classifier-worker.mjs"));
  try {
    const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const frame = await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } })
      .composite([{ input: red, left: 5, top: 3 }]).png().toBuffer();
    const input = { type: "image" as const, data: frame.toString("base64"), mimeType: "image/png" };
    const whole = await classifier.classify({ image: input, condition: "red pixel", threshold: .5 });
    const region = { x: 5, y: 3, width: 2, height: 2 };
    const selected = await classifier.classify({ image: input, region, condition: "red pixel", threshold: .5 });
    expect(whole.value).toBe(false);
    expect(selected).toMatchObject({ value: true, region, image: whole.image, cache_hit: true });
    const green = await classifier.classify({ image: input, region: { x: 0, y: 0, width: 2, height: 2 }, condition: "red pixel", threshold: .5 });
    expect(green.value).toBe(false);
    const edge = await classifier.classify({ image: input, region: { x: 7, y: 7, width: 1, height: 1 }, condition: "red pixel", threshold: .5 });
    expect(edge.value).toBe(false);
    const rotated = await sharp(frame).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    await expect(classifier.classify({ image: { ...input, data: rotated.toString("base64"), mimeType: "image/jpeg" }, region, condition: "red pixel", threshold: .5 })).rejects.toThrow(/EXIF rotation/);
  } finally { await classifier.close(); }
});

test("one batch returns ordered independent decisions for one shared image and condition", async () => {
  const classifier = new VisualClassifier({ python: process.execPath, model: "fixture" }, path.resolve("test/fixtures/visual-classifier-worker.mjs"));
  try {
    const red = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "green" } })
      .composite([{ input: red, left: 5, top: 3 }]).png().toBuffer();
    const input = { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
    const regions = [{ x: 5, y: 3, width: 2, height: 2 }, { x: 0, y: 0, width: 2, height: 2 }];
    const batch = await classifier.classify({ image: input, regions, condition: "red pixel", threshold: .5 });
    expect(batch.results).toEqual([{ region: regions[0], value: true, score: 1 }, { region: regions[1], value: false, score: 0 }]);
    const single = await classifier.classify({ image: input, region: regions[0], condition: "red pixel", threshold: .5 });
    expect(batch.image).toEqual(single.image);
    expect(single.cache_hit).toBe(true);
    const boundary = await classifier.classify({ image: input, regions, condition: "red pixel", threshold: 1 });
    expect(boundary.results.map(result => result.value)).toEqual([null, false]);
    await expect(classifier.classify({ image: input, regions, condition: "bad batch receipt", threshold: .5 })).rejects.toThrow(/receipt/);
  } finally { await classifier.close(); }
});

test("a batch refuses invalid collections and excessive crop area before starting a worker", async () => {
  const classifier = new VisualClassifier({ python: "/no-such-batch-worker", model: "fixture" });
  try {
    const input = await image(), region = { x: 0, y: 0, width: 8, height: 8 };
    for (const regions of [[], Array.from({ length: 17 }, () => region), [region, { ...region, x: 1 }]]) {
      await expect(classifier.classify({ image: input, regions, condition: "red pixel", threshold: .5 })).rejects.toThrow(/region/i);
    }
    await expect(classifier.classify({ image: input, region, regions: [region], condition: "red pixel", threshold: .5 })).rejects.toThrow(/region/i);
    const bytes = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: "green" } }).png().toBuffer();
    const large = { ...input, data: bytes.toString("base64") };
    const regions = Array.from({ length: 3 }, () => ({ x: 0, y: 0, width: 4000, height: 2000 }));
    await expect(classifier.classify({ image: large, regions, condition: "red pixel", threshold: .5 })).rejects.toThrow(/area/);
  } finally { await classifier.close(); }
});
test("invalid regions reject before starting the worker, without clipping", async () => {
  const classifier = new VisualClassifier({ python: "/no-such-region-worker", model: "fixture" });
  try {
    const input = await image();
    for (const region of [
      { x: -1, y: 0, width: 2, height: 2 }, { x: 0, y: 0, width: 0, height: 2 },
      { x: 7, y: 7, width: 2, height: 2 }, { x: .5, y: 0, width: 2, height: 2 },
      { x: 0, y: NaN, width: 2, height: 2 }, { x: 0, y: 0, width: 2, height: Infinity },
    ]) {
      await expect(classifier.classify({ image: input, region, condition: "red pixel", threshold: .5 })).rejects.toThrow(/region/i);
    }
  } finally { await classifier.close(); }
});
test("saved image input is bounded and config is not part of the request", async () => {
  await mkdir(".tmp/classifier-predicate", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp/classifier-predicate/contract-"));
  const classifier = new VisualClassifier({ python: process.execPath, model: "fixture" }, path.resolve("test/fixtures/visual-classifier-worker.mjs"));
  try {
    const pixels = await image(); await writeFile(path.join(dir, "image.png"), Buffer.from(pixels.data, "base64"));
    expect(await classifier.classify({ image: "image.png", condition: "visible", threshold: .3 }, undefined, dir)).toMatchObject({ value: true, image: { width: 8, height: 8 } });
    await writeFile(path.join(dir, "bad.png"), "not pixels");
    await expect(classifier.classify({ image: "bad.png", condition: "visible", threshold: .3 }, undefined, dir)).rejects.toThrow();
  } finally { await classifier.close(); await rm(dir, { recursive: true, force: true }); }
});
