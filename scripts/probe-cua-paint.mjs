import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { CuaBrowser } from "../src/cua-browser.ts";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { inspectPaintWindow } from "./raise-paint-window.mjs";

// Opt-in diagnosis on one newly owned browser. --driver-front explicitly permits
// CUA activation; other modes never activate. No desktop capture or input replay.
const comparePage = process.argv.includes("--compare-native-page");
const raiseNoActivate = process.argv.includes("--raise-noactivate");
const driverFront = process.argv.includes("--driver-front");
assert.ok(!(raiseNoActivate && driverFront), "Choose one window-raise control.");
const manualBackground = process.argv.includes("--manual-background") || raiseNoActivate || driverFront;
assert.ok(!(comparePage && manualBackground), "The manual background test must not force a CUA page screenshot.");
const directory = `.tmp/cua-pivot/paint-probe${comparePage ? "-page" : driverFront ? "-driver-front" : raiseNoActivate ? "-raise-noactivate" : manualBackground ? "-manual" : ""}-${Date.now()}`;
await mkdir(directory, { recursive: true });
const events = [];
const records = [];
const nativeCalls = [];
const page = `<!doctype html><meta charset="utf-8"><title>Pi CUA paint probe</title>
<style>body{background:#ffe600;font:48px sans-serif}button{font:40px sans-serif}</style>
<h1 id="stage">STAGE ZERO</h1><button>Advance</button>
<script>let n=0;const labels=['ZERO','ONE','TWO'];document.querySelector('button').onclick=()=>{
 n++;document.querySelector('#stage').textContent='STAGE '+labels[n];
 document.body.style.background=n===1?'#00dd55':'#ff6699';
 requestAnimationFrame(()=>requestAnimationFrame(()=>fetch('/paint?stage='+n,{method:'POST'})));
};</script>`;
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/paint?")) {
    events.push({ url: req.url, time: Date.now() }); res.writeHead(204).end(); return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(page);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let driver;
let session;
let target;
const browser = new CuaBrowser(async () => {
  driver = new McpDriver(await loadComputerConfig(process.cwd(), "0.33.1"), "0.33.1");
  return {
    async call(name, args, signal) {
      session = args.session ?? session;
      const start = performance.now();
      const result = await driver.call(name, args, signal);
      nativeCalls.push({ name, args, elapsed_ms: performance.now() - start, state: result.structuredContent, isError: result.isError ?? false });
      return result;
    },
    identity: (value, create, signal) => driver.identity(value, create, signal),
    close: () => driver.close(),
  };
});
async function save(label, content, state) {
  const images = [];
  for (const [index, block] of content.entries()) {
    if (block.type !== "image") continue;
    const bytes = Buffer.from(block.data, "base64");
    const file = `${records.length}-${index}.png`;
    await writeFile(`${directory}/${file}`, bytes);
    images.push({ file, bytes: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") });
  }
  records.push({ label, time: Date.now(), state, images, fixtureEvents: [...events] });
  await writeFile(`${directory}/run.json`, JSON.stringify({ url, records, nativeCalls }, null, 2) + "\n");
}
async function call(operation, args = {}) {
  const result = await browser.call(operation, args);
  await save(operation, result.content, result.details);
  assert.ok(!result.isError, result.details.text);
  return result.details;
}
try {
  let state = await call("open", { url });
  target = { pid: state.agent_image.native.pid, window_id: state.agent_image.native.window_id };
  const query = `$ProgressPreference="SilentlyContinue"; Get-CimInstance Win32_Process -Filter "ProcessId=${target.pid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const launch = execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(query, "utf16le").toString("base64")], { encoding: "utf8" });
  await writeFile(`${directory}/owned-launch.json`, launch);
  if (manualBackground) {
    console.log(JSON.stringify({ phase: "ready-before-input", target, url, directory }));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { assert.equal((await prompt.question("Cover the owned browser without minimizing it, then send continue: ")).trim(), "continue"); }
    finally { prompt.close(); }
    await save("operator-background-gate", [], { note: "Operator confirmation, not an independently measured occlusion state." });
    if (raiseNoActivate || driverFront) {
      const focus = inspectPaintWindow(target);
      await save("covered-focus-before-input", [], focus);
      assert.notEqual(focus.after.foreground_hwnd, target.window_id);
      assert.ok(focus.after.foreground_hwnd && focus.after.gui_read);
    }
    state = await call("observe");
  }
  for (const stage of manualBackground ? ["ONE"] : ["ONE", "TWO"]) {
    const button = state.elements.filter(element => element.name === "Advance");
    assert.equal(button.length, 1);
    await call("act", { click: button[0].hint, observe: false });
    state = await call("observe");
    assert.ok(state.text.includes(`STAGE ${stage}`));
    for (const pause of [0, 250, 1000, 3000]) {
      await delay(pause);
      const result = await driver.call("get_window_state", { ...target, session, include_accessibility_tree: false, max_image_dimension: 500 });
      await save(`direct-${stage}-${pause}ms`, result.content, result.structuredContent);
      assert.ok(!result.isError);
    }
    if (comparePage) {
      const binding = nativeCalls.find(call => call.name === "get_browser_state" && call.state?.mode === "bind")?.state;
      assert.ok(binding?.target_id && binding.tabs.length === 1);
      const result = await driver.call("get_browser_state", { session, target_id: binding.target_id, tab_id: binding.tabs[0].tab_id, snapshot_format: "semantic_v2", include_screenshot: true });
      await save(`native-page-${stage}`, result.content, result.structuredContent);
      assert.ok(!result.isError);
      const window = await driver.call("get_window_state", { ...target, session, include_accessibility_tree: false, max_image_dimension: 500 });
      await save(`window-after-page-${stage}`, window.content, window.structuredContent);
      assert.ok(!window.isError);
    }
    // Renew only observation before the next single input; never click again
    // because a capture may lag behind the fixture's semantic state.
    state = await call("observe");
  }
  if (raiseNoActivate || driverFront) {
    let raised;
    if (driverFront) {
      const before = inspectPaintWindow(target);
      await save("focus-before-driver-front", [], before);
      const args = { ...target, session }; const start = performance.now();
      const result = await driver.call("bring_to_front", args);
      nativeCalls.push({ name: "bring_to_front", args, elapsed_ms: performance.now() - start, state: result.structuredContent, isError: result.isError ?? false });
      await save("driver-bring-to-front", result.content, result.structuredContent);
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      raised = inspectPaintWindow(target);
      await save("focus-immediately-after-driver-front", [], raised);
    } else {
      raised = inspectPaintWindow(target, { raise: true });
      await save("raise-noactivate", [], raised);
      assert.ok(raised.raised, `SetWindowPos failed: ${raised.win32_error}`);
      assert.equal(raised.after.foreground_hwnd, raised.before.foreground_hwnd, "Foreground changed during raise");
      assert.ok(raised.before.gui_read && raised.after.gui_read);
      assert.equal(raised.after.keyboard_focus_hwnd, raised.before.keyboard_focus_hwnd, "Keyboard focus changed during raise");
      assert.deepEqual(raised.after.bounds, raised.before.bounds);
    }
    for (const pause of [0, 250, 1000, 3000]) {
      await delay(pause);
      const result = await driver.call("get_window_state", { ...target, session, include_accessibility_tree: false, max_image_dimension: 500 });
      await save(`window-after-${driverFront ? "driver-front" : "noactivate"}-${pause}ms`, result.content, result.structuredContent);
      assert.ok(!result.isError);
      const focus = inspectPaintWindow(target);
      await save(`focus-after-${driverFront ? "driver-front" : "noactivate"}-${pause}ms`, [], focus);
      if (!driverFront) {
        assert.equal(focus.after.foreground_hwnd, raised.before.foreground_hwnd, "Foreground changed after raise");
        assert.ok(focus.after.gui_read);
        assert.equal(focus.after.keyboard_focus_hwnd, raised.before.keyboard_focus_hwnd, "Keyboard focus changed after raise");
      }
    }
    await call("observe");
    console.log(JSON.stringify({ phase: driverFront ? "raised-through-driver" : "raised-without-activation", target, directory, focus: raised }));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { assert.equal((await prompt.question("Inspect the raised window and confirm the result, then send finish: ")).trim(), "finish"); }
    finally { prompt.close(); }
    await save("operator-raised-gate", [], { note: "Human visibility answer is recorded separately; this gate adds no page input.", driverFront });
  } else if (manualBackground) {
    console.log(JSON.stringify({ phase: "captured-in-background", target, directory }));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { assert.equal((await prompt.question("Uncover this same browser, then send uncover for a read-only comparison: ")).trim(), "uncover"); }
    finally { prompt.close(); }
    await save("operator-uncover-gate", [], { note: "Operator confirmation, not an independently measured foreground state." });
    await call("observe");
  }
} finally {
  try { await call("close"); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
console.log(JSON.stringify({ directory, records: records.length, fixtureEvents: events, manualPixelInspectionRequired: true }));
