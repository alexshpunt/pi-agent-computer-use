import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import sharp from "sharp";
import { CuaBrowser } from "../src/cua-browser.ts";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { startOverlayPeer } from "../src/window-overlay-peer.ts";

// Opt-in Windows qualification. One owned synthetic browser; private desktop captures stay in .tmp.
const command = process.env.PI_WINDOW_OVERLAY_PATH;
assert.ok(command?.endsWith("/pi-window-overlay.exe"), "Set the trusted built helper path.");
const directory = `.tmp/qt-overlay/native-${Date.now()}`;
await mkdir(directory, { recursive: true });
const server = createServer((_req, response) => response.end(`<!doctype html><meta charset="utf-8">
<title>Pi Qt observation frame check</title><style>body{background:#eee;font:28px sans-serif}button,input{font:24px sans-serif}</style>
<h1>Window frame check</h1><p>The cyan frame is human-only. It must not take keyboard focus.</p>
<button onclick="this.textContent='Clicked through frame'">Click through the frame</button>
<input aria-label="Keyboard check" placeholder="Type here while the frame is visible">`));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let driver; let session; let peer; let target; let generation = 0;
const records = [];
const browser = new CuaBrowser(async () => {
  driver = new McpDriver(await loadComputerConfig(process.cwd()));
  return { call: async (name, args, signal) => { session = args.session ?? session; return driver.call(name, args, signal); },
    identity: (...args) => driver.identity(...args), close: () => driver.close() };
});
const inspect = () => {
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type 'using System; using System.Runtime.InteropServices; public class FrameState {
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h,out uint a);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }';
[uint32]$affinity=0; [void][FrameState]::GetWindowDisplayAffinity([IntPtr]${peer.ready.overlay_hwnd},[ref]$affinity);
$process=Get-Process -Id ${peer.ready.pid} -ErrorAction SilentlyContinue;
@{Visible=[FrameState]::IsWindowVisible([IntPtr]${peer.ready.overlay_hwnd}); Affinity=$affinity;
Foreground=[FrameState]::GetForegroundWindow().ToInt64(); Present=($null -ne $process);
WorkingSet=$process.WorkingSet64; PrivateBytes=$process.PrivateMemorySize64;
SourcePresent=[FrameState]::IsWindow([IntPtr]${target.window_id})}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 15000 }));
};
const desktop = async label => {
  const result = await driver.call("get_desktop_state", { session, max_image_dimension: 0 });
  assert.ok(!result.isError); const image = result.content.find(block => block.type === "image"); assert.ok(image);
  const bytes = Buffer.from(image.data, "base64"); await writeFile(`${directory}/${label}.png`, bytes);
  return sharp(bytes).extract(region).raw().toBuffer();
};
let region;
try {
  const opened = await browser.call("open", { url }); assert.equal(opened.details.status, "observed", opened.details.text);
  await writeFile(`${directory}/overview.png`, Buffer.from(opened.content.find(block => block.type === "image").data, "base64"));
  target = { pid: opened.details.agent_image.native.pid, window_id: opened.details.agent_image.native.window_id };
  const bounds = opened.details.agent_image.native.window_bounds;
  region = { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height };
  const identity = await driver.identity(target, false); assert.ok(identity);
  await writeFile(`${directory}/source-metadata.json`, JSON.stringify({ target, bounds, identity }, null, 2));
  const showOnly = process.argv.includes("--show");
  const before = showOnly ? undefined : await desktop("hidden-before");
  if (!showOnly) {
    await delay(150);
    assert.deepEqual(await desktop("hidden-stable"), before, "The static owned window must settle before comparing frame pixels.");
  }
  const started = performance.now(); peer = await startOverlayPeer(command);
  records.push({ label: "ready", native: peer.ready, startup_ms: performance.now() - started, ...(showOnly ? {} : { state: inspect() }) });
  const flash = () => peer.send({ kind: "flash", generation: ++generation, duration_ms: 2000, target, identity, bounds });
  // Save refusal diagnostics too, before assertions or human waiting.
  const shown = await flash(); records.push({ label: "flash", native: shown });
  assert.equal(shown.status, "shown", JSON.stringify(shown));
  assert.equal(shown.focus_unchanged, true); assert.equal(shown.foreground_unchanged, true);
if (!showOnly) {
    const visible = inspect(); assert.equal(visible.Visible, true); assert.equal(visible.Affinity, 17);
    await flash(); const active = await desktop("frame-active");
    assert.deepEqual(active, before, "A visible human frame must not alter the owned-window region of CUA desktop pixels.");
    records.push({ label: "active", native: shown, state: visible, identical_owned_region_pixels: true });
    await delay(2150); const expired = inspect(); assert.equal(expired.Visible, false);
    records.push({ label: "expired", state: expired });
  }
  if (process.argv.includes("--human") || showOnly) {
    console.log(JSON.stringify({ phase: "human-check", directory, target, helper: peer.ready, url }));
    let failure;
    const pulse = setInterval(() => { void flash().then(reply => { if (reply.status !== "shown") console.log(JSON.stringify({phase:"frame-refused",reply})); }).catch(error => { failure = error; }); }, 1500);
    const keepAlive = setInterval(() => { void browser.call("tabs", {}).catch(error => { failure = error; }); }, 5000);
    await flash();
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { assert.equal((await prompt.question("Check the real frame, click and type in the owned page; then send finish: ")).trim(), "finish"); }
    finally { clearInterval(pulse); clearInterval(keepAlive); prompt.close(); }
    if (failure) throw failure;
    await peer.send({ kind: "hide", generation: ++generation });
    const state = await browser.call("observe", {});
    records.push({ label: "human-page-result", ...state.details });
    assert.equal(state.details.status, "observed", state.details.text);
  }
} finally {
  if (peer) await peer.close();
  await browser.call("close", {}); await new Promise(resolve => server.close(resolve));
  if (peer && target) records.push({ label: "cleanup", state: inspect() });
  await writeFile(`${directory}/run.json`, JSON.stringify({ records, private_pixels: true, purpose: "owned synthetic fixture and private exclusion comparison" }, null, 2));
}
assert.equal(records.at(-1).state.Present, false); assert.equal(records.at(-1).state.SourcePresent, false);
console.log(JSON.stringify({ success: true, directory, records: records.length }));
