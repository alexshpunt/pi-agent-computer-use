import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";

// Opt-in setup only. Measured captures use production computer_* tools, not this runner.
assert.ok(process.argv.includes("--live-approved"), "Explicit disposable-window approval is required.");
const config = await loadComputerConfig(process.cwd());
const notepad = JSON.parse(await readFile(".tmp/lpt-625/notepad.json", "utf8"));
const directory = `.tmp/lpt-625/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const driver = new McpDriver(config);
const nativeRoot = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
let revision = 1;
const events = [];
const server = http.createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/state") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ revision })); return;
  }
  if (request.url?.startsWith("/event?")) {
    events.push({ at: Date.now(), query: request.url }); response.end("ok"); return;
  }
  const sentinel = request.url === "/sentinel";
  if (!sentinel && request.url !== "/target") { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><meta charset="utf-8"><title>Pi background capture ${sentinel ? "sentinel" : "target"}</title>
<style>body{margin:0;padding:30px;font:40px system-ui;background:${sentinel ? "#ae36c8" : "#2549f5"};color:white}#marker{font-size:64px}</style>
<h1>${sentinel ? "OCCLUDER / SENTINEL" : "CHROME TARGET 625"}</h1><div id="marker">STARTING</div>
<p>Disposable LPT-625 window. No documents or accounts.</p>
<script>
const sentinel=${sentinel};
for(const event of ['focus','blur','visibilitychange'])addEventListener(event,()=>fetch('/event?kind='+event+'&sentinel='+sentinel));
async function update(){const s=await(await fetch('/state')).json();document.querySelector('#marker').textContent=(sentinel?'SENTINEL':'MARKER')+' '+s.revision;
if(!sentinel)document.body.style.background=s.revision%2?'#2549f5':'#60c973';}
update();setInterval(update,200);
</script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const owned = [];
let probe;
let probeLine;
let serial = 0;
const call = async (name, args) => {
  const result = await driver.call(name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
};
const record = async (label, data) => {
  await writeFile(`${directory}/${++serial}-${label}.json`, JSON.stringify(data, null, 2));
  const printed = label === "foreground" ? { sentinel: data.sentinel, count: data.samples.length,
    first: data.samples[0], last: data.samples.at(-1), foregrounds: [...new Set(data.samples.map(s => s.split(":")[1]))] } : data;
  console.log(JSON.stringify({ label, data: printed }));
};
// Read-only native foreground sampling. No capture, input, activation or desktop lifecycle APIs.
const startProbe = async () => {
  const script = String.raw`$ErrorActionPreference='Stop';
Add-Type 'using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Threading;
public class CaptureFocusProbe {
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
static object gate=new object(); static Timer timer; static List<string> rows=new List<string>();
public static void Begin(){lock(gate){rows.Clear();} long start=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); timer=new Timer(_=>{long now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();if(now-start>120000)return;lock(gate){if(rows.Count<6000)rows.Add(now+":"+GetForegroundWindow().ToInt64());}},null,0,20);}
public static string[] End(){timer.Dispose();lock(gate){return rows.ToArray();}}
}';
'READY';
while($null-ne($line=[Console]::ReadLine())) {
 if($line-eq'begin'){[CaptureFocusProbe]::Begin();'STARTED'}
 elseif($line-eq'end'){ConvertTo-Json -Compress -InputObject @([CaptureFocusProbe]::End())}
 elseif($line-eq'finish'){break}
}`;
  probe = spawn("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env: { ...process.env, WSL_INTEROP: config.interop }, stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  probe.stderr.on("data", data => { errors += data; });
  const lines = createInterface({ input: probe.stdout })[Symbol.asyncIterator]();
  probeLine = async () => {
    let timeout;
    try {
      const next = await Promise.race([lines.next(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(Error(`Foreground probe timeout: ${errors}`)), 15000);
      })]);
      assert.ok(!next.done, `Foreground probe exited: ${errors}`); return next.value.trim();
    } finally { clearTimeout(timeout); }
  };
  assert.equal(await probeLine(), "READY");
};
try {
  const windows = (await call("list_windows", {})).windows;
  assert.ok(windows.some(w => w.pid === notepad.target.pid && w.window_id === notepad.target.window_id && w.title.includes("LPT-625 disposable")), "Existing disposable Notepad must match its discovered lifetime target.");
  owned.push(await openCompleteInputWindow(driver, `${url}/target`, nativeRoot));
  owned.push(await openCompleteInputWindow(driver, `${url}/sentinel`, nativeRoot));
  const manifest = { directory, url, runtime: config.runtime, notepad,
    windows: owned.map((w, i) => ({ title: `Pi background capture ${i ? "sentinel" : "target"}`, target: w.target, profile: w.profile })) };
  await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ directory, url, titles: manifest.windows.map(w => w.title) }));
  console.log("Setup commands: cover, advance, state, begin, end, finish. No target input during measured captures. Keep workspace until cleanup.");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const command = line.trim();
    if (command === "finish") break;
    if (command === "advance") { revision++; await record("expected", { revision, events }); }
    else if (command === "cover") {
      for (const target of [notepad.target, owned[0].target])
        await call("set_window_frame", { ...target, x: 150, y: 180, width: 900, height: 800 });
      await call("set_window_frame", { ...owned[1].target, x: 70, y: 70, width: 1200, height: 1100 });
      await record("setup", await call("bring_to_front", owned[1].target));
    } else if (command === "state") {
      const windows = (await call("list_windows", {})).windows.filter(w => [notepad.target, ...owned.map(w => w.target)].some(t => t.pid === w.pid && t.window_id === w.window_id));
      await record("state", { revision, windows, events });
    } else if (command === "begin") {
      if (!probe) await startProbe();
      probe.stdin.write("begin\n"); assert.equal(await probeLine(), "STARTED");
      console.log("Foreground measurement started (20ms sampling goal).");
    } else if (command === "end") {
      assert.ok(probe, "No measurement started."); probe.stdin.write("end\n");
      const samples = JSON.parse(await probeLine()); await record("foreground", { sentinel: owned[1].target.window_id, samples });
    } else console.log("Unknown command; no action.");
  }
  input.close();
} finally {
  if (probe) { probe.stdin.write("finish\n"); probe.stdin.end(); probe.kill(); }
  const cleanup = [];
  try {
    for (const window of owned.reverse()) {
      try { cleanup.push({ target: window.target, profile: window.profile, status: "closed", ...await window.close() }); }
      catch (error) { cleanup.push({ target: window.target, profile: window.profile, status: "unknown", error: String(error) }); }
    }
  } finally { await driver.close(); await new Promise(resolve => server.close(resolve)); }
  await record("cleanup", cleanup);
  if (cleanup.some(row => row.status !== "closed")) {
    process.exitCode = 1;
    console.log("Automatic cleanup incomplete. Verify remaining task windows; never bypass ownership or replay an uncertain close.");
  } else console.log("Chrome fixtures cleaned. Disposable Notepad remains for grounded document cleanup.");
}
