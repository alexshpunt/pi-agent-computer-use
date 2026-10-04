import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { BrowserClient } from "../src/browser-client.ts";
import { startBrowserFixture } from "../test/fixtures/browser-site.mjs";
import { browserNativeState } from "./browser-native-state.mjs";

// Opt-in native regression: a screenshot crop uses viewport coordinates even after scrolling.
const directory = ".tmp/browser-region";
await mkdir(directory, { recursive: true });
const baseline = await browserNativeState();
const fixture = await startBrowserFixture();
const client = new BrowserClient();
const records = [];
let success = false;
const call = async (operation, args, status = "observed") => {
  const result = await client.call(operation, args);
  records.push({ operation, args, details: result.details });
  assert.equal(result.details.status, status, JSON.stringify(result.details));
  return result;
};
try {
  await call("open", { url: fixture.url + "/pointer" });
  await call("act", { scroll: 50, observe: false }, "acted");
  const region = { x: 100, y: 50, width: 100, height: 80 };
  const cropped = await call("observe", { region });
  assert.deepEqual(cropped.details.image_region, region);
  assert.ok(cropped.details.screenshot.width > region.width && cropped.details.screenshot.height > region.height);
  assert.deepEqual(cropped.content.map(item => item.type), ["image"]);
  const png = Buffer.from(cropped.content[0].data, "base64");
  assert.equal(png.readUInt32BE(16), 100);
  assert.equal(png.readUInt32BE(20), 80);
  await writeFile(`${directory}/crop.png`, png);
  await call("act", { click: { x: 150, y: 90 }, observe: true });
  const full = await call("observe", {});
  assert.match(full.details.text, /Clicks: 1/);
  assert.deepEqual(cropped.details.screenshot, full.details.screenshot);
  const pixels = await call("observe", { image_only: true });
  assert.deepEqual(pixels.content.map(item => item.type), ["image"]);
  assert.equal(pixels.details.timings.semantics_ms, undefined);
  success = true;
} finally {
  assert.equal((await client.close()).details.status, "closed");
  await fixture.close();
  const cleanup = await browserNativeState();
  assert.equal(cleanup.browserCount, baseline.browserCount);
  assert.equal(cleanup.workerCount, baseline.workerCount);
  assert.deepEqual([...cleanup.profiles].sort(), [...baseline.profiles].sort());
  await writeFile(`${directory}/run.json`, JSON.stringify({ success, records, baseline, cleanup }, null, 2) + "\n");
}
console.log(JSON.stringify({ success, operations: records.length, directory }));
