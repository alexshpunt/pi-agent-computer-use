import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { nativeWindowState } from "./native-window-state.mjs";
import { assertBridgeDispatchAllowed, assertBridgeWitness, assertRetiredBridgeRef, assertSelectedBridgeTab } from "./owned-browser-bridge-contract.mjs";

// Research only: one CUA-owned profile/tab, typed semantic DOM, native WGC pixels.
// This does not register browser tools or attach another browser/capture backend.
assert.deepEqual(process.argv.slice(2), ["--live-approved"], "Explicit disposable-browser live approval is required.");
const command = process.env.CUA_DRIVER_PATH, expectedHash = process.env.CUA_DRIVER_SHA256;
assert.ok(command?.endsWith(".exe"));
assert.match(expectedHash ?? "", /^[a-f0-9]{64}$/);
assert.ok(process.env.WSL_INTEROP && (await stat(process.env.WSL_INTEROP)).isSocket());
const sha256 = createHash("sha256").update(await readFile(command)).digest("hex");
assert.equal(sha256, expectedHash, "Do not silently qualify other driver bytes.");
const directory = `.tmp/lpt-732/live-${Date.now()}`, nonce = randomUUID(), session = `pi-bridge-${randomUUID()}`;
await mkdir(directory, { recursive: true });
const records = [], reports = [];
let rejected = 0, started = false, target, page, input, stopping = false, attempted = false, profile;
const html = `<!doctype html><meta charset="utf-8"><title>Pi owned bridge ${nonce.slice(0, 8)}</title>
<style>body{font:24px sans-serif;padding:24px}button{font:inherit;padding:12px}p{overflow-wrap:anywhere}</style>
<h1>Same-tab CUA bridge</h1><p id="session"></p><p id="storage"></p><p id="count">Bridge count: 0</p>
<button id="advance">Advance bridge count</button><p id="route">No action yet</p>
<script>
const nonce=${JSON.stringify(nonce)}, pageNonce=crypto.randomUUID();
const previous=localStorage.getItem('pi-bridge-nonce');localStorage.setItem('pi-bridge-nonce',nonce);
document.querySelector('#session').textContent='Session: '+nonce;
document.querySelector('#storage').textContent='Storage: '+localStorage.getItem('pi-bridge-nonce');
let count=0, events=[];
for(const type of ['keydown','keyup','beforeinput','input','mousedown','mouseup','pointerdown','pointerup','wheel','click'])
 document.addEventListener(type,e=>events.push({type,trusted:e.isTrusted,target:e.target.id}),true);
document.querySelector('#advance').onclick=e=>{count++;document.querySelector('#count').textContent='Bridge count: '+count;
 document.querySelector('#route').textContent='DOM click trusted: '+e.isTrusted;send();};
function send(){fetch('/witness',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,pageNonce,count,
 storage:localStorage.getItem('pi-bridge-nonce'),previous,events,location:location.href})}).catch(()=>{});}
send();setInterval(send,300);
</script>`;
const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/witness") {
    let body = "";
    try {
      for await (const chunk of req) { body += chunk; assert.ok(body.length <= 32_000); }
      const report = JSON.parse(body);
      assert.equal(report.nonce, nonce);
      assert.ok(typeof report.pageNonce === "string" && Number.isInteger(report.count) && Array.isArray(report.events));
      assert.ok((req.headers.cookie ?? "").split(/;\s*/).includes(`pi_bridge=${nonce}`), "Synthetic HttpOnly cookie did not persist.");
      assert.ok(reports.length < 2000, "Bounded witness journal exhausted.");
      reports.push({ ...report, cookie: nonce, received_ms: Date.now() });
      res.writeHead(204).end();
    } catch { rejected++; res.writeHead(400).end(); }
    return;
  }
  if (req.method !== "GET" || req.url !== "/") { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Set-Cookie", `pi_bridge=${nonce}; HttpOnly; SameSite=Strict; Path=/`);
  res.end(html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const transport = new StdioClientTransport({
  command, args: ["mcp", "--direct", "--embedded"], stderr: "pipe",
  env: { WSL_INTEROP: process.env.WSL_INTEROP,
    WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"].filter(Boolean).join(":"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", DO_NOT_TRACK: "1" },
});
let stderr = "";
transport.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
const client = new Client({ name: "pi-owned-browser-bridge-research", version: "0.0.0" });
const save = () => writeFile(`${directory}/run.json`, JSON.stringify({ command, sha256, session, url, nonce, target, page, profile,
  attempted, records, reports, rejected }, null, 2) + "\n");
async function call(name, args, allowRefusal = false) {
  assertBridgeDispatchAllowed(stopping, name);
  const start = performance.now();
  let result;
  try { result = await client.callTool({ name, arguments: { ...args, session } }, undefined, { timeout: 30_000 }); }
  catch (error) { records.push({ name, args, error: String(error), execution: "unknown; never replay" }); await save(); throw error; }
  const images = [];
  for (const [index, block] of (result.content ?? []).entries()) if (block.type === "image") {
    const filename = `${records.length}-${index}.png`;
    assert.equal(block.mimeType, "image/png", "Do not relabel native images.");
    await writeFile(`${directory}/${filename}`, Buffer.from(block.data, "base64")); images.push(filename);
  }
  const record = { name, args, elapsed_ms: performance.now() - start, isError: result.isError ?? false,
    structuredContent: result.structuredContent, text: (result.content ?? []).filter(block => block.type === "text").map(block => block.text), images };
  records.push(record); await save(); console.log(JSON.stringify({ ...record, directory }));
  assert.ok(allowRefusal || !result.isError, `${name} refused; stop without fallback/replay.`);
  return result;
}
async function witness(label, expectedCount) {
  for (let i = 0; i < 30 && (!reports.length || reports.at(-1).count !== expectedCount); i++) await delay(100);
  const native_state = target ? await nativeWindowState(process.env.WSL_INTEROP, [target]) : null;
  const report = reports.at(-1);
  assertBridgeWitness(report, nonce, expectedCount, rejected, reports.map(row => row.pageNonce));
  const record = { label, report, native_state, rejected };
  await writeFile(`${directory}/${label}.json`, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ directory, ...record })); return record;
}
async function selectedWindow() {
  const bound = (await call("get_browser_state", target)).structuredContent;
  assertSelectedBridgeTab(bound, url, `Pi owned bridge ${nonce.slice(0, 8)}`);
  // Bind mode mints fresh IDs. Never replace the original action target/tab/ref.
}
async function capture() {
  await selectedWindow();
  // Native window pixels only, never Page.captureScreenshot or foreground assistance.
  const result = await call("get_window_state", { ...target, capture_backend: "wgc", include_accessibility_tree: false, max_image_dimension: 800 });
  assert.ok(result.content.some(block => block.type === "image"), "Native capture returned no pixels.");
  await selectedWindow();
}
async function selectedQuery(query) {
  await selectedWindow();
  const result = await call("get_browser_state", { ...page, snapshot_format: "semantic_v2", query, include_screenshot: false });
  const state = result.structuredContent;
  assert.equal(state.target_id, page.target_id); assert.equal(state.tab_id, page.tab_id);
  assert.equal(state.page.url, url); assert.equal(state.page.title, `Pi owned bridge ${nonce.slice(0, 8)}`);
  return state;
}
async function ownedProfile(pid) {
  // Read only the exact prepared process command line; never enumerate personal browsers.
  const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if(!$p){throw 'Owned process gone'};$p.CommandLine`;
  const { stdout } = await promisify(execFile)("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 10_000, env: { ...process.env, WSL_INTEROP: process.env.WSL_INTEROP } });
  const match = stdout.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/);
  assert.ok(match, "Missing exact owned profile path; cleanup cannot be verified.");
  const windowsPath = match[1] ?? match[2];
  assert.match(windowsPath, /^[A-Za-z]:\\/);
  const local = `/mnt/${windowsPath[0].toLowerCase()}/${windowsPath.slice(3).replaceAll("\\", "/")}`;
  assert.ok((await stat(local)).isDirectory()); return { windowsPath, local };
}
const stop = () => { stopping = true; input?.close(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const lifetime = setTimeout(() => { process.exitCode = 1; stop(); }, 8 * 60_000);
try {
  await client.connect(transport, { timeout: 15_000 });
  assert.equal(client.getServerVersion()?.name, "cua-driver");
  await call("start_session", {}); started = true;
  const prepared = (await call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } })).structuredContent;
  assert.equal(prepared.prepared, true); assert.ok(Number.isSafeInteger(prepared.prepared_pid));
  profile = await ownedProfile(prepared.prepared_pid);
  const windows = (await call("list_windows", { pid: prepared.prepared_pid })).structuredContent.windows;
  assert.equal(windows.length, 1, "Require exactly one owned window.");
  target = { pid: windows[0].pid, window_id: windows[0].window_id };
  assert.equal(target.pid, prepared.prepared_pid);
  const bound = (await call("get_browser_state", target)).structuredContent;
  assert.equal(bound.binding_quality, "exact"); assert.equal(bound.mutation_allowed, true);
  assert.equal(bound.tabs.length, 1); assert.equal(bound.tabs[0].active, true);
  page = { target_id: bound.target_id, tab_id: bound.tabs[0].tab_id };
  await call("browser_navigate", { ...page, url });
  await witness("baseline", 0);
  const state = await selectedQuery("Advance bridge count");
  const matches = state.refs.filter(ref => ref.name === "Advance bridge count");
  assert.equal(matches.length, 1); assert.ok(matches[0].actions.includes("click"));
  const ref = matches[0].ref;
  await capture(); await witness("query-and-capture", 0);
  console.log(JSON.stringify({ ready: true, directory, target, page, ref, profile,
    commands: "act (once, explicit DOM event), capture (readonly), stale (once after new snapshot), state, finish" }));
  assertBridgeDispatchAllowed(stopping, "interactive_wait");
  input = createInterface({ input: process.stdin });
  let staleAttempted = false;
  for await (const line of input) {
    if (stopping || line.trim() === "finish") break;
    if (line.trim() === "act") {
      assert.equal(attempted, false, "Never replay the measured action.");
      await selectedWindow();
      attempted = true; await save();
      await call("browser_click", { ...page, ref, input_route: "dom_event", delivery_mode: "background" });
      await witness("after-dom-action", 1); await capture();
      await selectedQuery("Bridge count"); await witness("after-capture-and-query", 1);
    } else if (line.trim() === "capture") { await capture(); await witness(`readonly-capture-${records.length}`, attempted ? 1 : 0); }
    else if (line.trim() === "state") await witness(`state-${records.length}`, attempted ? 1 : 0);
    else if (line.trim() === "stale") {
      assert.ok(attempted && !staleAttempted); staleAttempted = true;
      const refused = await call("browser_click", { ...page, ref, input_route: "dom_event", delivery_mode: "background" }, true);
      assertRetiredBridgeRef(refused);
      await witness("retired-ref-refused", 1);
    } else console.log("Commands: act, capture, stale, state, finish");
  }
} finally {
  input?.close();
  const cleanup = {};
  try { if (started) { await call("end_session", {}); cleanup.sessionEnded = true; } }
  catch (error) { cleanup.error = String(error); process.exitCode = 1; }
  clearTimeout(lifetime);
  try {
    if (target && profile) {
      for (let i = 0; i < 5; i++) {
        const native = await nativeWindowState(process.env.WSL_INTEROP, [target]);
        const profileExists = await stat(profile.local).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
        cleanup.native_state = native; cleanup.profileExists = profileExists;
        if (native.status === "measured" && native.windows[0].exists === false && !profileExists) break;
        await delay(100);
      }
      if (cleanup.native_state.status !== "measured" || cleanup.native_state.windows[0].exists !== false || cleanup.profileExists) process.exitCode = 1;
    } else if (started) { cleanup.verification = "Exact owned window/profile unavailable; cleanup not independently verified."; process.exitCode = 1; }
  } catch (error) { cleanup.verification_error = String(error); process.exitCode = 1; }
  const releases = await Promise.allSettled([
    (async () => { try { await client.close(); } finally { await transport.close(); } })(),
    new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  ]);
  cleanup.release_errors = releases.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  if (cleanup.release_errors.length) process.exitCode = 1;
  await save(); await writeFile(`${directory}/stderr.log`, stderr);
  await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2) + "\n");
  console.log(JSON.stringify({ directory, cleanup }));
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
}
