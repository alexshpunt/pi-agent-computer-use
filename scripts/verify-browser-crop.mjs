import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { BrowserClient } from "../src/browser-client.ts";
import { VisionImages } from "../src/vision-images.ts";
import { startCropFixture } from "./crop-fixture.mjs";
import { browserNativeState } from "./browser-native-state.mjs";

const directory = ".tmp/crop/native";
await mkdir(directory, { recursive: true });
const fixture = await startCropFixture(); const baseline = await browserNativeState();
const images = new VisionImages(); const browser = new BrowserClient(undefined, images);
const records = []; let success = false;
const call = async (operation, args = {}, status = "observed") => {
  const result = await browser.call(operation, args);
  records.push({ operation, args, details: result.details, ...(result.isError ? { reason: result.content[0].text } : {}) });
  assert.equal(result.details.status, status, JSON.stringify(result)); return result;
};
const save = async (result, name) => {
  const image = result.content.find(block => block.type === "image"); assert.ok(image);
  await writeFile(`${directory}/${name}.png`, Buffer.from(image.data, "base64")); return image;
};
const rectangle = (view, css) => {
  const m = view.details.agent_image.mapping;
  return { x: (css.x - m.offsetX) / m.scaleX, y: (css.y - m.offsetY) / m.scaleY,
    width: css.width / m.scaleX, height: css.height / m.scaleY };
};
try {
  await call("observe", { crop: { x: 0, y: 0, width: 1, height: 1 } }, "refused");
  const overview = await call("open", { url: fixture.url }); await save(overview, "overview");
  assert.equal(overview.details.agent_image.output.width, 500);
  const css = overview.details.screenshot; const raster = overview.details.agent_image.source;
  // This machine reproduced1086CSS versus1085PNG; they are different coordinate spaces, not changed viewports.
  records.push({ kind: "css-raster-contract", css, raster: { width: raster.width, height: raster.height } });
  await call("observe", { crop: { x: 499, y: 0, width: 2, height: 1 } }, "refused");
  const detail = await call("observe", { crop: { ...rectangle(overview, { x: 95, y: 95, width: 610, height: 190 }), maxLongEdge: 1200 } });
  const image = await save(detail, "detail");
  const origin = detail.details.agent_image.origin;
  assert.equal(origin.observation, overview.details.agent_image.origin.observation);
  assert.equal(detail.details.agent_image.source.hash, raster.hash);
  const expected = await sharp(images.asset(raster.hash)).extract({ left: origin.raster.x, top: origin.raster.y, width: origin.raster.width, height: origin.raster.height }).raw().toBuffer();
  assert.deepEqual(await sharp(Buffer.from(image.data, "base64")).raw().toBuffer(), expected);
  const nested = await call("observe", { crop: { x: 15, y: 60, width: 350, height: 90, maxLongEdge: 1000, scale: 1 } });
  await save(nested, "nested"); assert.equal(nested.details.agent_image.source.hash, raster.hash);
  assert.equal(nested.details.agent_image.origin.observation, origin.observation);
  assert.deepEqual(images.settings(), { kernel: "mks2021", maxLongEdge: 500, scale: 1, version: 0 });
  await call("observe", { crop: { x: 0, y: 0, width: 10, height: 10 }, image_only: true }, "refused");
  const fresh = await call("observe", {});
  const target = await call("observe", { crop: { ...rectangle(fresh, { x: 100, y: 330, width: 100, height: 80 }), maxLongEdge: 800, scale: 1 } });
  await save(target, "target");
  await call("act", { click: { x: target.details.agent_image.output.width / 2, y: target.details.agent_image.output.height / 2 }, observe: false }, "acted");
  const history = await call("observe", { crop: { x: 0, y: 0, width: 30, height: 30 } });
  assert.equal(history.details.agent_image.origin.inputReady, false);
  await call("act", { click: { x: 10, y: 10 } }, "refused");
  const verified = await call("observe", {}); assert.match(verified.details.text, /Clicks: 1/);
  await call("act", { scroll: 200, observe: false }, "acted");
  const old = await call("observe", { crop: { x: 0, y: 0, width: 100, height: 50 } });
  assert.equal(old.details.agent_image.origin.inputReady, false);
  await call("act", { click: { x: 10, y: 10 } }, "refused");
  const region = await call("observe", { region: { x: 100, y: 130, width: 100, height: 80 } });
  assert.equal(region.details.agent_image.origin.kind, "fresh_capture");
  assert.deepEqual(region.details.screenshot, css);
  await save(region, "fresh-region");
  await call("act", { click: { x: 50, y: 40 }, observe: false }, "acted");
  const checked = await call("observe", {}); assert.match(checked.details.text, /Clicks: 2/);
  await call("open", { url: fixture.url }); await call("focus", { tab: 1 });
  await call("act", { close_tab: true }, "closed");
  await call("observe", { crop: { x: 0, y: 0, width: 1, height: 1 } }, "refused");
  const aborted = new AbortController(); aborted.abort();
  const cancelled = await browser.call("observe", { crop: { x: 0, y: 0, width: 1, height: 1 } }, aborted.signal);
  assert.equal(cancelled.details.status, "refused"); records.push({ kind: "cancelled", details: cancelled.details });
  assert.equal((await browser.close()).details.status, "closed");
  const run = promisify(execFile);
  let worker = fileURLToPath(new URL("../test/fixtures/crop-geometry-worker.ts", import.meta.url));
  const node = process.platform === "win32" ? process.execPath : "/mnt/c/Program Files/nodejs/node.exe";
  if (process.platform !== "win32") worker = (await run("wslpath", ["-w", worker])).stdout.trim();
  const geometry = await run(node, [worker, fixture.url], { timeout: 45_000 });
  records.push({ kind: "native-geometry", result: JSON.parse(geometry.stdout.trim()) });
  success = true;
} finally {
  assert.equal((await browser.close()).details.status, "closed"); await fixture.close();
  const cleanup = await browserNativeState();
  assert.equal(cleanup.workerCount, baseline.workerCount); assert.equal(cleanup.browserCount, baseline.browserCount);
  assert.deepEqual([...cleanup.profiles].sort(), [...baseline.profiles].sort());
  await writeFile(`${directory}/run.json`, JSON.stringify({ success, records, baseline, cleanup }, null, 2) + "\n");
}
console.log(JSON.stringify({ success, operations: records.length, directory }));
