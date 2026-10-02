import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { ComputerSession } from "../src/session.ts";

// Opt-in native contract check, NOT a simulation of interactive user command input.
// Only the disposable canary created by prepare-safe-canary.mjs is authorized. No app is launched here.
const prepared = JSON.parse(await readFile(".tmp/safe-prepared.json", "utf8"));
assert.equal(prepared.opened, true);
const target = prepared.target;
assert.ok(Number.isSafeInteger(target?.pid) && Number.isSafeInteger(target?.window_id));
const native = new McpDriver(await loadComputerConfig(process.cwd()));
const calls = [];
const driver = {
  call(name, args, signal) {
    calls.push({ name, ...(args.pid ? { pid: args.pid, window_id: args.window_id } : {}) });
    return native.call(name, args, signal);
  },
  identity(target, create, signal) {
    calls.push({ name: "identity", ...target, create });
    return native.identity(target, create, signal);
  },
  close: () => native.close(),
};
let mode = "yolo";
const session = new ComputerSession(driver, () => mode);
let summary;
try {
  const listed = await session.windows(undefined, "Notepad");
  const window = listed.details.state.windows.find(window => window.pid === target.pid && window.window_id === target.window_id);
  assert.ok(window?.window_ref, "Authorized canary is missing; do not select a different window.");
  const before = await session.observe(window.window_ref);
  assert.equal(before.details.status, "observed");
  const editor = before.details.state.elements.find(element => element.role === "Document");
  assert.equal(editor?.value, "SAFE canary 365");
  const firstImage = before.content.find(block => block.type === "image");
  await writeFile(".tmp/safe-canary-written.png", Buffer.from(firstImage.data, "base64"));
  const checkpoint = calls.length;
  mode = "safe"; // Trusted test controller only; the interactive user path is verified separately in Pi.
  const hidden = await session.windows(undefined, "Notepad");
  const read = await session.observe(window.window_ref);
  const write = await session.act({ window_ref: window.window_ref, observation_id: before.details.observation_id,
    action: "type_text", element_token: editor.element_token, text: "BLOCKED SAFE 365" });
  assert.deepEqual(hidden.details.state.windows, []);
  assert.equal(read.details.status, "refused");
  assert.equal(write.details.status, "refused");
  const deniedCalls = calls.slice(checkpoint);
  assert.deepEqual(deniedCalls, [], "Safe denial dispatched native work.");
  mode = "yolo";
  const after = await session.observe(window.window_ref);
  assert.equal(after.details.status, "observed");
  assert.equal(after.details.state.elements.find(element => element.role === "Document")?.value, editor.value);
  const image = after.content.find(block => block.type === "image");
  await writeFile(".tmp/safe-canary-after-denial.png", Buffer.from(image.data, "base64"));
  summary = { success: true, controller: "trusted native contract script, not interactive user command",
    target, beforeValue: editor.value, afterValue: editor.value, deniedCalls,
    hidden: hidden.details, read: read.details, write: write.details, calls };
} finally { await session.close(); }
await writeFile(".tmp/safe-native-denial.json", JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
