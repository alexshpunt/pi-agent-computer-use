import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { BrowserClient } from "../src/browser-client.ts";
import { VisionImages, visionKernels } from "../src/vision-images.ts";
import { VisionTrace } from "../src/vision-trace.ts";
import { startVisionServer } from "../src/vision-server.ts";
import { startBrowserFixture } from "../test/fixtures/browser-site.mjs";
import { browserNativeState } from "./browser-native-state.mjs";

// Opt-in native check: real physical PNGs, source-point dispatch and actual viewer controls.
const directory = ".tmp/vision-scale/native";
await mkdir(directory, { recursive: true });
const images = new VisionImages(); const trace = new VisionTrace("native-scale");
const viewer = await startVisionServer(trace, images);
const fixture = await startBrowserFixture();
const client = new BrowserClient(undefined, images);
const records = [];
const call = async (operation, args = {}, expected = "observed") => {
  const result = await client.call(operation, args);
  records.push({ operation, args, details: result.details });
  assert.equal(result.details.status, expected, JSON.stringify(result));
  const image = result.content.find(block => block.type === "image");
  if (image) {
    const actual = await sharp(Buffer.from(image.data, "base64")).metadata();
    assert.equal(actual.width, result.details.agent_image.output.width);
    assert.equal(actual.height, result.details.agent_image.output.height);
    assert.ok(Math.max(actual.width, actual.height) <= result.details.agent_image.cap);
  }
  return result;
};
let success = false;
try {
  let current = await call("open", { url: fixture.url + "/pointer" });
  assert.deepEqual(current.details.agent_image.configuration, { kernel: "mks2021", maxLongEdge: 500, scale: 1, version: 0 });
  assert.equal(current.details.agent_image.cap, 500);
  const source = images.asset(current.details.agent_image.source.hash);
  await writeFile(directory + "/original.png", source);
  for (const kernel of visionKernels) {
    images.update({ kernel, maxLongEdge: 800, scale: 0.5 });
    current = await call("observe", {});
    assert.equal(current.details.agent_image.output.width, 400);
    await writeFile(directory + "/" + kernel + ".png", Buffer.from(current.content.find(block => block.type === "image").data, "base64"));
  }
  const mapping = current.details.agent_image.mapping;
  await call("act", { click: { x: 150 / mapping.scaleX, y: 140 / mapping.scaleY }, observe: false }, "acted");
  await call("act", { click: { x: 1, y: 1 } }, "refused");
  current = await call("observe", {});
  assert.match(current.details.text, /Clicks: 1/);
  await writeFile(directory + "/clicked.png", Buffer.from(current.content.find(block => block.type === "image").data, "base64"));
  const before = current.details.agent_image;
  // Region support is a separate browser follow-up; this runner checks the shipped full-frame path.
  // Open the existing loopback panel in a second owned tab and use only observed hint input.
  let panel = await call("open", { url: viewer.url });
  let controls = panel.details.elements;
  const find = (role, name) => {
    const target = controls.find(item => item.role === role && item.name.includes(name));
    assert.ok(target, "Missing control " + role + " " + name + " in " + JSON.stringify(controls)); return target.hint;
  };
  await call("act", { press: find("combobox", "Downsampling"), key: "ArrowUp", observe: false }, "acted");
  await call("act", { press: find("input", "Scale"), key: "ArrowLeft", observe: false }, "acted");
  panel = await call("observe", {});
  controls = panel.details.elements;
  const sliderValue = panel.details.elements.find(item => item.name.startsWith("Scale slider"))?.value;
  assert.ok(Number(sliderValue) < 0.5);
  assert.equal(panel.details.elements.find(item => item.name.startsWith("Scale exact"))?.value, sliderValue);
  await call("act", { fill: find("input", "Scale exact"), text: "0.45", observe: false }, "acted");
  await call("act", { fill: find("input", "Max long edge"), text: "1600", observe: false }, "acted");
  await call("act", { click: find("button", "Apply to next capture"), wait_ms: 200, observe: true });
  assert.equal(images.settings().maxLongEdge, 1600);
  assert.equal(images.settings().kernel, "mitchell");
  assert.equal(images.settings().scale, 0.45);
  assert.equal(before.configuration.maxLongEdge, 800);
  panel = await call("observe", {});
  await writeFile(directory + "/panel.png", Buffer.from(panel.content.find(block => block.type === "image").data, "base64"));
  success = true;
} finally {
  const close = await client.close(); assert.equal(close.details.status, "closed");
  await fixture.close(); await viewer.close();
  const cleanup = await browserNativeState();
  await writeFile(directory + "/run.json", JSON.stringify({ success, records, cleanup }, null, 2) + "\n");
  assert.equal(cleanup.browserCount, 0); assert.equal(cleanup.workerCount, 0); assert.equal(cleanup.profiles.length, 0);
}
console.log(JSON.stringify({ success, directory, operations: records.length }));
