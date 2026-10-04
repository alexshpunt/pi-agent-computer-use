import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { ComputerSession } from "../src/session.ts";
import { CuaBrowser } from "../src/cua-browser.ts";
import { createCuaBrowserSite } from "../test/fixtures/cua-browser-site.mjs";

// Opt-in native fixture. All display pixels and local window metadata stay ignored.
if (!process.argv.includes("--allow-primary-display")) throw Error("Explicit primary-display permission is required.");
const directory = ".tmp/native-zoom/native";
await mkdir(directory, { recursive: true });
const backend = new McpDriver(await loadComputerConfig(process.cwd()));
const calls = [];
const driver = {
  async call(name, args, signal) { calls.push({ name, args }); return backend.call(name, args, signal); },
  identity: (...args) => backend.identity(...args), close: () => backend.close(),
};
const session = new ComputerSession(driver);
const browser = new CuaBrowser(async () => new McpDriver(await loadComputerConfig(process.cwd())));
const records = [];
let owned;
const site = await createCuaBrowserSite();
async function save(name, result) {
  assert.equal(result.details.status, "observed", JSON.stringify(result.details));
  const image = result.content.find(b => b.type === "image"); assert.ok(image);
  await writeFile(`${directory}/${name}.${image.mimeType === "image/jpeg" ? "jpg" : "png"}`, Buffer.from(image.data, "base64"));
  records.push({ name, source: result.details.source, agent_image: result.details.agent_image });
  return result.details;
}
async function closeCalculator() {
  const fresh = await session.observe(owned);
  if (fresh.details.status !== "observed") {
    const found = await session.windows(undefined, "Calculator");
    assert.ok(!found.details.state.windows.some(w => w.window_ref === owned)); owned = undefined; return;
  }
  const closer = fresh.details.state.elements.find(e => /close calculator/i.test(e.label)); assert.ok(closer);
  const closed = await session.act({ window_ref: owned, observation_id: fresh.details.observation_id, action: "click", element_token: closer.element_token });
  assert.equal(closed.details.status, "delivered");
  const found = await session.windows(undefined, "Calculator");
  assert.ok(!found.details.state.windows.some(w => w.window_ref === owned), "Owned Calculator must disappear."); owned = undefined;
}
try {
  const open = await session.open("Calculator"); owned = open.details.window_ref;
  const win = await save("calculator-overview", open);
  const { width, height } = win.source.image.dimensions;
  const rect = { image_id: win.agent_image.image_id, x: width * 0.1, y: height * 0.25, width: width * 0.7, height: height * 0.5 };
  const detail = await session.observe(owned, undefined, undefined, rect);
  await save("calculator-detail", detail);
  assert.equal(detail.details.source.capabilities.input, "none");
  const count = calls.length;
  assert.equal((await session.act({window_ref:owned,observation_id:win.observation_id,action:"click",x:1,y:1})).details.status,"refused");
  assert.equal((await session.observe(owned, undefined, undefined, rect)).details.status, "refused");
  assert.equal(calls.length, count);
  assert.ok(!calls.some(c => ["bring_to_front", "get_desktop_state"].includes(c.name)));
  await closeCalculator();
  const opened = await browser.call("open", {url:site.url});
  const browserState = await save("browser-fixture", opened);
  assert.ok(browserState.text.includes("Pi CUA owned browser"));
  const display = await save("display-overview", await session.observeDisplay("primary"));
  const original = display.source.image.original_dimensions;
  assert.ok(original, "Native original display dimensions are required.");
  const bounds = browserState.source.image.native_bounds;
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= original.width && bounds.y + bounds.height <= original.height,
    "The owned synthetic window must fit inside the primary display.");
  const image = display.source.image.dimensions;
  const cropRect = {image_id:display.agent_image.image_id, x:bounds.x * image.width / original.width, y:bounds.y * image.height / original.height,
    width:bounds.width * image.width / original.width, height:bounds.height * image.height / original.height, maxLongEdge:1200,scale:1};
  const crop = await session.observeDisplay("primary", undefined, cropRect);
  const cropState = await save("display-detail", crop);
  assert.equal(cropState.source.capabilities.input, "none");
  assert.equal(cropState.agent_image.route, "cua_fresh_display_crop");
  assert.ok(!crop.details.observation_id && !crop.details.state);
  assert.equal(crop.content.filter(b=>b.type==="image").length,1);
  const after = calls.length;
  assert.equal((await session.observeDisplay("primary",undefined,cropRect)).details.status,"refused");
  assert.equal(calls.length,after);
  await writeFile(`${directory}/run.json`, JSON.stringify({success:true,version:"0.33.2",calls,records,oldInputDispatches:0,nestedCaptureDispatches:0,rawPixelsForwarded:0},null,2));
  console.log(JSON.stringify({success:true,directory,calls:calls.length,records:records.length}));
} finally {
  try { if(owned) await closeCalculator(); }
  finally { try { await browser.call("close",{}); } finally { await session.close(); await site.close(); } }
}
