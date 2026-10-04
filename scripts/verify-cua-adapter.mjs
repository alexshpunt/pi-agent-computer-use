import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { CuaBrowser } from "../src/cua-browser.ts";
import { McpDriver } from "../src/driver.ts";
import { createCuaBrowserSite } from "../test/fixtures/cua-browser-site.mjs";

// Opt-in replacement-adapter check. Only the Driver's isolated browser is touched.
const command = process.env.CUA_DRIVER_PATH;
assert.ok(command?.endsWith("/cua-driver-0.33.1/cua-driver.exe"), "Use the qualified separate Windows runtime.");
const directory = `.tmp/cua-pivot/adapter-foreground-${Date.now()}`;
await mkdir(directory, { recursive: true });
const site = await createCuaBrowserSite();
const nativeCalls = [];
const records = [];
const browser = new CuaBrowser(async () => {
  const driver = new McpDriver({ command }, "0.33.1");
  return {
    async call(name, args, signal) {
      const result = await driver.call(name, args, signal);
      nativeCalls.push({ name, args, isError: result.isError ?? false, state: result.structuredContent });
      return result;
    },
    identity: (target, create, signal) => driver.identity(target, create, signal),
    close: () => driver.close(),
  };
});
async function call(operation, args = {}, expected = "observed") {
  const start = performance.now();
  const result = await browser.call(operation, args);
  const images = [];
  for (const [index, block] of result.content.entries()) {
    if (block.type !== "image") continue;
    const filename = `${records.length}-${index}.${block.mimeType === "image/jpeg" ? "jpg" : "png"}`;
    await writeFile(`${directory}/${filename}`, Buffer.from(block.data, "base64"));
    images.push({ filename, mimeType: block.mimeType });
  }
  records.push({ operation, args, elapsed_ms: performance.now() - start, details: result.details, images });
  await writeFile(`${directory}/run.json`, JSON.stringify({ url: site.url, records, nativeCalls }, null, 2) + "\n");
  console.log(JSON.stringify({ operation, status: result.details.status, images }));
  assert.equal(result.details.status, expected, result.details.text);
  if (result.details.status === "observed") {
    assert.equal(result.details.foreground.route, "cua_bring_to_front");
    assert.equal(result.details.foreground.keyboard_focus_may_change, true);
    assert.equal(result.details.foreground.native.landed_on_target, true);
    assert.deepEqual(result.details.agent_image.foreground, result.details.foreground);
  }
  return result.details;
}
const hint = (state, name) => {
  const matches = state.elements.filter(e => e.name === name);
  assert.equal(matches.length, 1, `One target ${name} required.`);
  return matches[0].hint;
};
try {
  let state = await call("open", { url: site.url });
  assert.equal(state.agent_image.configuration.maxLongEdge, 500);
  assert.equal(state.agent_image.configuration.kernel, "lanczos3");
  const old = hint(state, "One");
  for (const name of ["One", "Two", "Three", "Four"])
    await call("act", { click: hint(state, name), observe: false }, "acted");
  state = await call("observe");
  assert.ok(state.text.includes("Selections: 4"));
  const count = nativeCalls.length;
  await call("act", { click: old, observe: false }, "refused");
  assert.equal(nativeCalls.length, count, "A retired alias must not reach CUA.");
  await call("act", { fill: hint(state, "Message"), text: "Pi CUA adapter 396", observe: false }, "acted");
  await call("act", { click: hint(state, "Submit"), observe: false }, "acted");
  state = await call("observe");
  assert.ok(state.text.includes("Submitted: Pi CUA adapter 396"));
  await call("act", { hover: hint(state, "Next local page"), observe: false }, "acted");
  await call("act", { scroll: { hint: hint(state, "Next local page"), delta_y: 700 }, observe: false }, "acted");
  await call("observe", { image_only: true });
  await call("act", { navigate: site.url + "next", observe: false }, "acted");
  state = await call("observe");
  assert.ok(state.text.includes("Next local page reached"));
  await call("tabs", {}, "listed");
  const firstPid = state.agent_image.native.pid;
  await call("close", {}, "closed");
  state = await call("open", { url: site.url });
  assert.notEqual(state.agent_image.native.pid, firstPid, "Reopening must create a new owned process.");
  assert.ok(state.text.includes("Previous fixture storage: empty"), "The fresh profile must not inherit fixture storage.");
  assert.ok(state.text.includes("Selections: 0"));
  console.log(JSON.stringify({ success: true, operations: records.length, directory }));
} finally {
  try { await call("close", {}, "closed"); }
  finally { await site.close(); }
}
