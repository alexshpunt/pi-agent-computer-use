import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { BrowserClient } from "../src/browser-client.ts";
import { VisionImages } from "../src/vision-images.ts";
import { VisionTrace } from "../src/vision-trace.ts";
import { startVisionServer } from "../src/vision-server.ts";
import { browserNativeState } from "./browser-native-state.mjs";

// Opt-in GUI contract check, not a model readability score. No expected text is read.
const directory = ".tmp/vision-scale/trial-native";
await mkdir(directory, { recursive: true });
const images = new VisionImages();
const viewer = await startVisionServer(new VisionTrace("native-trial"), images);
const client = new BrowserClient(undefined, images); const records = [];
const call = async (operation, args = {}, expected = "observed") => {
  const result = await client.call(operation, args);
  records.push({ operation, args, details: result.details });
  assert.equal(result.details.status, expected, JSON.stringify(result.details));
  return result;
};
const save = async (name, result) => writeFile(directory + "/" + name + ".png", Buffer.from(result.content.find(block => block.type === "image").data, "base64"));
let success = false;
try {
  let view = await call("open", { url: viewer.url + "trial" });
  assert.match(view.details.text, /Ready · trial/);
  assert.deepEqual(view.details.agent_image.configuration, { kernel: "mks2021", maxLongEdge: 500, scale: 1, version: 0 });
  const initial = view.details.text.match(/Ready · trial ([a-f0-9]{32})/)[1];
  await save("initial", view);
  await call("act", { scroll: 500, observe: false }, "acted");
  view = await call("observe", {});
  const target = name => {
    const item = view.details.elements.find(item => item.name.startsWith(name));
    assert.ok(item, "Missing control " + name); return item;
  };
  assert.equal(view.details.elements.filter(item => /^(Light|Dark) row \d ·/.test(item.name)).length, 12);
  assert.ok(!view.details.elements.some(item => item.name.includes("Confidence")));
  for (const column of ["Light", "Dark"]) for (let row = 1; row <= 6; row++)
    await call("act", { fill: target(column + " row " + row + " ·").hint, text: "deliberately incorrect", observe: false }, "acted");
  await call("act", { fill: target("Max long edge").hint, text: "800", observe: false }, "acted");
  await call("act", { fill: target("Scale exact").hint, text: "0.625", observe: false }, "acted");
  view = await call("observe", {});
  assert.equal(target("Scale slider").value, "0.625");
  assert.equal(target("Scale exact").value, "0.625");
  await call("act", { press: target("Scale slider").hint, key: "ArrowLeft", observe: false }, "acted");
  view = await call("observe", {});
  assert.equal(target("Scale slider").value, target("Scale exact").value);
  assert.ok(Number(target("Scale exact").value) < 0.625);
  await call("act", { fill: target("Scale exact").hint, text: "0.625", observe: false }, "acted");
  await call("act", { click: target("Apply: check and new trial").hint, observe: false, wait_ms: 300 }, "acted");
  // Capture only after Apply: its input operation began under the previous image settings.
  view = await call("observe", {});
  // Apply can finish during an observation that already froze old settings. Never grade that frame.
  for (let attempt = 0; attempt < 4 && view.details.agent_image.cap !== 500; attempt++) view = await call("observe", {});
  assert.match(view.details.text, /Light 0\/6, Dark 0\/6/);
  const next = view.details.text.match(/Ready · trial ([a-f0-9]{32})/)[1]; assert.notEqual(next, initial);
  assert.equal(images.settings().scale, 0.625);
  assert.equal(view.details.agent_image.cap, 500);
  const fields = view.details.elements.filter(item => /^(Light|Dark) row \d ·/.test(item.name));
  assert.equal(fields.length, 12); assert.ok(fields.every(item => !item.value));
  await save("checked-and-new", view);
  const results = await (await fetch(new URL("trial/results", viewer.url))).json();
  assert.equal(results.length, 1); assert.equal(results[0].rows.length, 12);
  assert.ok(results[0].rows.every(row => row.status === "wrong"));
  success = true;
} finally {
  await client.close(); await viewer.close();
  const cleanup = await browserNativeState();
  await writeFile(directory + "/run.json", JSON.stringify({ success, records, cleanup }, null, 2) + "\n");
  assert.equal(cleanup.browserCount, 0); assert.equal(cleanup.workerCount, 0); assert.equal(cleanup.profiles.length, 0);
}
console.log(JSON.stringify({ success, directory, operations: records.length }));
