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
