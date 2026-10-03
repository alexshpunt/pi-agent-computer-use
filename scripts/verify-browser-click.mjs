import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { BrowserClient } from "../src/browser-client.ts";
import { startBrowserFixture } from "../test/fixtures/browser-site.mjs";
import { browserNativeState } from "./browser-native-state.mjs";

// Opt-in Windows check on a custom local control absent from semantic element refs.
const directory = ".tmp/browser-click";
await mkdir(directory, { recursive: true });
const fixture = await startBrowserFixture();
const client = new BrowserClient();
const records = [];
const call = async (operation, args, status = "observed") => {
  const result = await client.call(operation, args);
  records.push({ operation, args, details: result.details });
  assert.equal(result.details.status, status, JSON.stringify(result.details));
  return result;
};
const point = state => ({ page_ref: state.details.page_ref, observation_id: state.details.observation_id,
  action: "click", x: 150, y: 140 });
const image = async (state, name) => {
  const png = Buffer.from(state.content.find(item => item.type === "image").data, "base64");
  assert.deepEqual(state.details.screenshot, { width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
  await writeFile(`${directory}/${name}.png`, png);
};
let success = false;
try {
  const opened = await call("open", { url: fixture.url + "/pointer" });
  assert.deepEqual(opened.details.elements, []);
  assert.match(opened.details.text, /Clicks: 0/);
  await image(opened, "before");
  await call("act", { ...point(opened), x: opened.details.screenshot.width }, "refused");
  const clicked = await call("act", point(opened));
  assert.match(clicked.details.text, /Clicks: 1/);
  await image(clicked, "clicked");
  await call("act", point(opened), "refused");
  const moving = await call("open", { url: fixture.url + "/pointer?scroll" });
  await setTimeout(3500);
  const stale = await call("act", point(moving), "refused");
  assert.match(stale.content[0].text, /Viewport, scroll or zoom changed/);
  const untouched = await call("observe", { page_ref: moving.details.page_ref });
  assert.match(untouched.details.text, /Clicks: 0/);
  success = true;
} finally {
  const closed = await client.close();
  assert.equal(closed.details.status, "closed");
  await fixture.close();
  const cleanup = await browserNativeState();
  assert.equal(cleanup.browserCount, 0); assert.equal(cleanup.workerCount, 0); assert.equal(cleanup.profiles.length, 0);
  await writeFile(`${directory}/run.json`, JSON.stringify({ success, records, cleanup }, null, 2) + "\n");
}
console.log(JSON.stringify({ success, directory, operations: records.length }));
