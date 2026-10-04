import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";

// Opt-in read-only comparison on an explicitly authorized synthetic fixture window.
// No launch, input, foreground change or desktop capture. Close only this transport.
const [pid, window_id] = process.argv.slice(2).map(Number);
assert.ok(Number.isSafeInteger(pid) && pid > 0);
assert.ok(Number.isSafeInteger(window_id) && window_id > 0);
const driver = new McpDriver(await loadComputerConfig(process.cwd(), "0.33.1"), "0.33.1");
const directory = ".tmp/cua-pivot/capture-probe";
const records = [];
await mkdir(directory, { recursive: true });
async function call(name, args) {
  const result = await driver.call(name, args);
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  const files = [];
  for (const [index, block] of result.content.entries()) {
    if (block.type !== "image") continue;
    const filename = `${records.length}-${index}.png`;
    await writeFile(`${directory}/${filename}`, Buffer.from(block.data, "base64"));
    files.push(filename);
  }
  records.push({ name, args, state: result.structuredContent, files });
  return result.structuredContent;
}
try {
  const windows = await call("list_windows", { pid });
  const target = windows.windows.find(window => window.pid === pid && window.window_id === window_id);
  assert.ok(target?.title.includes("Pi CUA adapter fixture"), "Only the authorized local fixture window is allowed.");
  for (const include_accessibility_tree of [false, true, false]) {
    await call("get_window_state", { pid, window_id, include_accessibility_tree, max_image_dimension: 500 });
  }
} finally {
  await writeFile(`${directory}/run.json`, JSON.stringify(records, null, 2) + "\n");
  await driver.close();
}
console.log(JSON.stringify({ directory, records: records.length }));
