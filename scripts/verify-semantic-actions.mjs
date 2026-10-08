import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";

// Setup and independent oracles only. Measured semantic actions use production computer_* tools.
assert.ok(process.argv.includes("--live-approved"), "Explicit disposable-window approval is required.");
const config = await loadComputerConfig(process.cwd());
assert.equal(config.runtime, "windows-semantic-actions", "Select the separately qualified candidate only after approval.");
const directory = `.tmp/lpt-626/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const driver = new McpDriver(config);
const nativeRoot = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const states = {}; const events = []; const owned = [];
let serial = 0, probe, probeLine, eventStart = 0, membershipBefore;
const server = http.createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/report" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) { body += chunk; if (body.length > 16000) { response.writeHead(413).end(); return; } }
    try { const state = JSON.parse(body); if (["target", "sentinel"].includes(state.kind)) states[state.kind] = { ...state, received_ms: Date.now() }; }
    catch { response.writeHead(400).end(); return; }
    response.end("ok"); return;
  }
  if (url.pathname === "/event") {
    if (events.length < 1000) events.push({ at: Date.now(), kind: url.searchParams.get("kind"), window: url.searchParams.get("window") });
    response.end("ok"); return;
  }
  const sentinel = url.pathname === "/sentinel";
  if (!sentinel && url.pathname !== "/target") { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><meta charset="utf-8"><title>Pi semantic ${sentinel ? "sentinel" : "target"}</title>
<style>body{padding:20px;font:24px system-ui;background:${sentinel ? "#d6bbff" : "#e3f3ff"}}input,button,select{font:24px system-ui;margin:10px}option{padding:12px}</style>
<h1>${sentinel ? "Sentinel: unchanged" : "Strict UIA target 626"}</h1>
${sentinel ? '<label>Sentinel value <input id="sentinel" aria-label="Sentinel value" value="Sentinel only" autofocus></label>' : `<button id="invoke" aria-label="Semantic invoke">Invoke counter</button><output id="count">0</output>
<label>Semantic value <input id="value" aria-label="Semantic value" value="before"></label>
<select id="choice" aria-label="Semantic selection" size="2"><option value="before" selected>Selection before</option><option value="after">Selection after</option></select>
<label><input id="radio1" type="radio" name="radio" value="before" checked>Radio before</label><label><input id="radio2" type="radio" name="radio" value="after">Radio after</label>
<button disabled aria-label="Disabled invoke">Disabled</button>`}
<p>Disposable local fixture. No accounts or documents.</p>
<script>
const kind=${JSON.stringify(sentinel ? "sentinel" : "target")};let count=0;
if(kind==='target')document.querySelector('#invoke').addEventListener('click',()=>document.querySelector('#count').textContent=++count);
for(const event of ['focus','blur','click','keydown','input','change'])addEventListener(event,()=>fetch('/event?kind='+event+'&window='+kind));
function report(){const state=kind==='sentinel'?{value:document.querySelector('#sentinel').value}:{count,value:document.querySelector('#value').value,selection:document.querySelector('#choice').value,radio:document.querySelector('input[name=radio]:checked').value};
fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,...state,active:document.activeElement.id,reported_ms:Date.now()})});}
report();setInterval(report,100);
</script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const record = async (label, data) => {
  await writeFile(`${directory}/${++serial}-${label}.json`, JSON.stringify(data, null, 2));
  console.log(JSON.stringify({ label, data: label === "measurement" ? { samples: data.samples.length, foregrounds: [...new Set(data.samples.map(s => s.foreground))],
    focuses: [...new Set(data.samples.map(s => s.focus))], sentinel: data.sentinel, states: data.states, events: data.events, events_capped: data.events_capped,
    desktop_membership_preserved: data.desktop_membership_preserved, membership_before: data.membership_before, membership_after: data.membership_after, limits: data.limits } : data }));
};
// Desktop membership is part of the measured result, not just focus stability.
async function membership() {
  const result = await driver.call("list_windows", {});
  assert.ok(!result.isError, "Cannot verify task desktop membership.");
  return result.structuredContent.windows.filter(w => owned.some(t => t.target.pid === w.pid && t.target.window_id === w.window_id))
    .map(w => ({ pid: w.pid, window_id: w.window_id, virtual_desktop: w.virtual_desktop }));
}
function sameMembership(before, after) {
  if (before.length !== owned.length || after.length !== owned.length) return null;
  const pairs = before.map(w => [w, after.find(a => a.pid === w.pid && a.window_id === w.window_id)]);
  if (pairs.some(([b, a]) => !a || !b.virtual_desktop?.desktop_id || !a.virtual_desktop?.desktop_id
    || typeof b.virtual_desktop.on_current_desktop !== "boolean" || typeof a.virtual_desktop.on_current_desktop !== "boolean")) return null;
  return pairs.every(([b, a]) => b.virtual_desktop.desktop_id === a.virtual_desktop.desktop_id
    && b.virtual_desktop.on_current_desktop === a.virtual_desktop.on_current_desktop);
}
// Read-only Windows sampling. No input, focus-setting, desktop switch or capture APIs.
async function startProbe() {
  const script = String.raw`$ErrorActionPreference='Stop';
Add-Type 'using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Threading;
public class SemanticFocusProbe {
[StructLayout(LayoutKind.Sequential)] struct RECT {public int left,top,right,bottom;}
[StructLayout(LayoutKind.Sequential)] struct INFO {public uint size,flags;public IntPtr active,focus,capture,menu,move,caret;public RECT rect;}
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint id,ref INFO info);
static object gate=new object();static Timer timer;static List<string> rows=new List<string>();
public static void Begin(){if(timer!=null)timer.Dispose();lock(gate){rows.Clear();}long start=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();timer=new Timer(_=>{long now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();if(now-start>120000)return;var info=new INFO{size=(uint)Marshal.SizeOf(typeof(INFO))};bool ok=GetGUIThreadInfo(0,ref info);lock(gate){if(rows.Count<6000)rows.Add(now+":"+GetForegroundWindow().ToInt64()+":"+(ok?info.focus.ToInt64():-1));}},null,0,20);}
public static string[] End(){timer.Dispose();timer=null;lock(gate){return rows.ToArray();}}
}';'READY';
while($null-ne($line=[Console]::ReadLine())) {if($line-eq'begin'){[SemanticFocusProbe]::Begin();'STARTED'}elseif($line-eq'end'){ConvertTo-Json -Compress -InputObject @([SemanticFocusProbe]::End())}elseif($line-eq'finish'){break}}`;
  probe = spawn("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, WSL_INTEROP: config.interop }, stdio: ["pipe", "pipe", "pipe"] });
  let errors = ""; probe.stderr.on("data", data => { errors = (errors + data).slice(-4000); });
  const lines = createInterface({ input: probe.stdout })[Symbol.asyncIterator]();
  probeLine = async () => {
    let timeout;
    try { const line = await Promise.race([lines.next(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(`Probe timeout: ${errors}`)), 15000); })]);
      assert.ok(!line.done, `Probe exited: ${errors}`); return line.value.trim();
    } finally { clearTimeout(timeout); }
  };
  assert.equal(await probeLine(), "READY");
}
try {
  owned.push(await openCompleteInputWindow(driver, `${url}/target`, nativeRoot));
  owned.push(await openCompleteInputWindow(driver, `${url}/sentinel`, nativeRoot));
  await record("manifest", { directory, url, runtime: config.runtime, windows: owned.map((w, i) => ({ title: `Pi semantic ${i ? "sentinel" : "target"}`, target: w.target, profile: w.profile })) });
  console.log("Commands: sentinel (setup only), state, begin, end, finish. Owner places only test windows; no workspace change before cleanup.");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const command = line.trim();
    if (command === "finish") break;
    if (command === "sentinel") { const result = await driver.call("bring_to_front", owned[1].target); assert.ok(!result.isError, JSON.stringify(result.structuredContent)); await record("sentinel-setup", result.structuredContent); }
    else if (command === "state") {
      const result = await driver.call("list_windows", {});
      await record("state", { states, windows: result.structuredContent.windows.filter(w => owned.some(t => t.target.pid === w.pid && t.target.window_id === w.window_id)), events });
    } else if (command === "begin") {
      if (!probe) await startProbe(); eventStart = events.length; membershipBefore = await membership();
      probe.stdin.write("begin\n"); assert.equal(await probeLine(), "STARTED");
      await record("begin", { states, sentinel: owned[1].target, membership: membershipBefore });
    } else if (command === "end") {
      assert.ok(probe, "Begin measurement first."); probe.stdin.write("end\n");
      const samples = JSON.parse(await probeLine()).map(row => { const [time_ms, foreground, focus] = row.split(":").map(Number); return { time_ms, foreground, focus }; });
      const membershipAfter = await membership();
      await record("measurement", { samples, sentinel: owned[1].target, states, events: events.slice(eventStart),
        membership_before: membershipBefore, membership_after: membershipAfter, desktop_membership_preserved: sameMembership(membershipBefore, membershipAfter),
        events_capped: events.length >= 1000,
        limits: "20ms sampling goal, bounded to 120s/6000 rows; fixture events capped at1000. No proof of all intermediate focus or future provider behavior." });
    } else console.log("Unknown command; no action.");
  }
  input.close();
} finally {
  if (probe) { probe.stdin.write("finish\n"); probe.stdin.end(); probe.kill(); }
  const cleanup = [];
  try { for (const window of owned.reverse()) {
    try { cleanup.push({ target: window.target, profile: window.profile, status: "closed", ...await window.close() }); }
    catch (error) { cleanup.push({ target: window.target, profile: window.profile, status: "unknown", error: String(error) }); }
  } } finally { await driver.close(); await new Promise(resolve => server.close(resolve)); }
  await record("cleanup", cleanup);
  if (cleanup.some(row => row.status !== "closed")) { process.exitCode = 1; console.log("Cleanup incomplete. Discover remaining task windows; never bypass native ownership."); }
}
