import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { BrowserClient } from "../src/browser-client.ts";
import { startBrowserFixture } from "../test/fixtures/browser-site.mjs";
import { browserNativeState } from "./browser-native-state.mjs";

// Opt-in real Windows check. Only this client's disposable browser and synthetic pages.
const directory = ".tmp/browser-focus";
await mkdir(directory, { recursive: true });
const fixture = await startBrowserFixture();
const client = new BrowserClient();
const records = [];
const call = async (operation, args = {}, status = "observed") => {
  const result = await client.call(operation, args);
  records.push({ operation, args, details: result.details, images: result.content.filter(block => block.type === "image").length,
    ...(result.isError ? { reason: result.content[0].text } : {}) });
  assert.equal(result.details.status, status, JSON.stringify(records.at(-1)));
  return result;
};
const hint = (state, name) => {
  const target = state.details.elements.find(element => element.name === name);
  assert.ok(target, `Missing target ${name}: ${JSON.stringify(state.details.elements)}`);
  return target.hint;
};
const image = async (state, name) => {
  const png = state.content.find(block => block.type === "image"); assert.ok(png);
  await writeFile(`${directory}/${name}.png`, Buffer.from(png.data, "base64"));
};
let success = false;
try {
  await call("open", { url: fixture.url + "/focus" });
  const focused = await call("focus", { tab: 1 });
  const choices = ["One", "Two", "Three", "Four"].map(name => hint(focused, name));
  assert.equal(new Set(choices).size, 4);
  await image(focused, "hints");
  const start = records.length;
  for (const click of choices) {
    const result = await call("act", { click }, "acted");
    assert.equal(result.content.some(block => block.type === "image"), false);
  }
  assert.equal(records.slice(start).filter(record => record.operation === "observe").length, 0);
  let state = await call("observe");
  assert.match(state.details.text, /Selections: 4/);
  await image(state, "selected");
  await call("act", { fill: hint(state, "Message"), text: "Pi focused browser" }, "acted");
  await call("act", { click: hint(state, "Submit message") }, "acted");
  state = await call("observe");
  assert.match(state.details.text, /Confirmed: Pi focused browser/);
  await image(state, "confirmed");

  const removed = hint(state, "Four selected");
  await call("act", { click: hint(state, "Remove fourth choice") }, "acted");
  const denied = await call("act", { click: removed }, "refused");
  assert.match(denied.content[0].text, /removed|old document/);
  state = await call("observe"); assert.match(state.details.text, /Selections: 4/);
  const old = hint(state, "One selected");
  await call("act", { click: hint(state, "Open second tab"), wait_ms: 300 }, "acted");
  const tabs = await call("tabs", {}, "listed");
  const second = tabs.details.tabs.find(tab => tab.title === "Pi browser second tab"); assert.ok(second);
  await call("focus", { tab: second.tab });
  await call("act", { click: old }, "refused");
  state = await call("focus", { tab: 1 });
  const navigated = hint(state, "One selected");
  await call("act", { click: hint(state, "Navigate away") }, "acted");
  await call("act", { click: navigated }, "refused");
  state = await call("observe"); assert.match(state.details.text, /Second owned tab/);

  assert.equal((await client.close()).details.status, "closed");
  state = await call("open", { url: fixture.url + "/focus" });
  assert.notEqual(hint(state, "One"), old);
  await call("act", { click: old }, "refused");
  assert.match(state.details.text, /Selections: 0/);
  success = true;
} finally {
  assert.equal((await client.close()).details.status, "closed");
  await fixture.close();
  const cleanup = await browserNativeState();
  assert.equal(cleanup.browserCount, 0); assert.equal(cleanup.workerCount, 0); assert.equal(cleanup.profiles.length, 0);
  await writeFile(`${directory}/run.json`, JSON.stringify({ success, records, cleanup }, null, 2) + "\n");
}
console.log(JSON.stringify({ success, operations: records.length, directory }));
