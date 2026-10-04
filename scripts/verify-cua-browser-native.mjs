import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Opt-in CUA-only Windows qualification. The driver owns the isolated profile.
// Only the prepared PID is enumerated; no existing browser or desktop is read.
const command = process.env.CUA_DRIVER_PATH;
assert.ok(command?.endsWith("/cua-driver-0.33.2/cua-driver.exe"), "Use the separately provisioned 0.33.2 runtime.");
const directory = ".tmp/cua-pivot/native";
await mkdir(directory, { recursive: true });
const session = `pi-browser-${randomUUID().slice(0, 8)}`;
const records = [];
const transport = new StdioClientTransport({
  command, args: ["mcp", "--direct", "--embedded"], stderr: "pipe",
  env: {
    WSL_INTEROP: process.env.WSL_INTEROP,
    WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"].filter(Boolean).join(":"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", DO_NOT_TRACK: "1",
  },
});
let stderr = "";
transport.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
const client = new Client({ name: "pi-cua-owned-browser-check", version: "0.0.0" });
const html = `<!doctype html><meta charset="utf-8"><title>Pi CUA local fixture</title>
<style>body{font:24px sans-serif;padding:30px}button,input{font:inherit;margin:8px}#small{font:14px monospace}#space{height:1200px}</style>
<h1>Pi CUA owned browser</h1><p id="count">Selections: 0</p>
<button>One</button><button>Two</button><button>Three</button><button>Four</button>
<p><label>Message <input id="message"></label><button id="submit">Submit</button></p><p id="result"></p>
<p id="small">Native detail: cedar river 396</p><a href="/next">Next local page</a><div id="space"></div><p>Bottom reached</p>
<script>let n=0;for(const b of document.querySelectorAll('button:not(#submit)'))b.onclick=()=>document.querySelector('#count').textContent='Selections: '+ ++n;
document.querySelector('#submit').onclick=()=>{const v=document.querySelector('#message').value;document.querySelector('#result').textContent='Submitted: '+v;localStorage.setItem('cua-test',v)};</script>`;
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url === "/next" ? "<!doctype html><title>Pi CUA second fixture</title><h1>Next local page reached</h1><a href='/'>Return</a>" : html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
async function call(name, args) {
  const start = performance.now();
  const result = await client.callTool({ name, arguments: { ...args, session } }, undefined, { timeout: 30_000 });
  const images = [];
  for (const [index, block] of result.content.entries()) {
    if (block.type !== "image") continue;
    const filename = `${records.length}-${index}.${block.mimeType === "image/jpeg" ? "jpg" : "png"}`;
    await writeFile(`${directory}/${filename}`, Buffer.from(block.data, "base64"));
    images.push({ filename, mimeType: block.mimeType });
  }
  const record = { name, args, elapsed_ms: performance.now() - start, isError: result.isError ?? false,
    structuredContent: result.structuredContent, text: result.content.filter(b => b.type === "text").map(b => b.text), images };
  records.push(record);
  await writeFile(`${directory}/run.json`, JSON.stringify({ command, session, url, records }, null, 2) + "\n");
  console.log(JSON.stringify(record));
  assert.ok(!result.isError, `${name} refused: ${record.text.join("\n")}`);
  return result.structuredContent;
}
let started = false;
try {
  await client.connect(transport, { timeout: 15_000 });
  assert.deepEqual(client.getServerVersion(), { name: "cua-driver", version: "0.33.2" });
  await call("start_session", {});
  started = true;
  const prepared = await call("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } });
  assert.equal(prepared.prepared, true);
  assert.ok(Number.isInteger(prepared.prepared_pid));
  const windows = await call("list_windows", { pid: prepared.prepared_pid });
  await writeFile(`${directory}/prepared.json`, JSON.stringify({ prepared, windows }, null, 2) + "\n");
  assert.equal(windows.windows.length, 1, "Exactly one owned browser window is required.");
  const window = windows.windows[0];
  assert.equal(window.pid, prepared.prepared_pid);
  const target = { pid: window.pid, window_id: window.window_id };
  const bound = await call("get_browser_state", target);
  assert.equal(bound.binding_quality, "exact");
  assert.equal(bound.tabs.length, 1);
  assert.equal(bound.tabs[0].active, true);
  const page = { target_id: bound.target_id, tab_id: bound.tabs[0].tab_id };
  await call("set_agent_cursor_enabled", { enabled: true });
  await call("set_agent_cursor_motion", { glide_duration_ms: 250, idle_hide_ms: 5000 });
  await call("browser_navigate", { ...page, url });
  const snapshot = () => call("get_browser_state", { ...page, snapshot_format: "semantic_v2" });
  let state = await snapshot();
  const find = name => {
    const matches = state.refs.filter(r => r.name === name);
    assert.equal(matches.length, 1, `Exactly one semantic target ${name} is required.`);
    return matches[0].ref;
  };
  await call("get_window_state", { ...target, max_image_dimension: 500, include_accessibility_tree: false });
  for (const name of ["One", "Two", "Three", "Four"])
    await call("browser_click", { ...page, ref: find(name), delivery_mode: "background", input_route: "trusted" });
  state = await snapshot();
  assert.ok(JSON.stringify(state).includes("Selections: 4"));
  await call("browser_type", { ...page, ref: find("Message"), text: "Pi CUA native 396", replace: true });
  await call("browser_click", { ...page, ref: find("Submit"), delivery_mode: "background", input_route: "trusted" });
  state = await snapshot();
  assert.ok(JSON.stringify(state).includes("Submitted: Pi CUA native 396"));
  await call("get_window_state", { ...target, max_image_dimension: 500, include_accessibility_tree: false });
  await call("zoom", { ...target, x1: 24, y1: 165, x2: 65, y2: 197 });
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let point;
  try { point = (await prompt.question("Read the saved zoom image, then enter its grounded One-button x y: ")).trim().split(/\s+/).map(Number); }
  finally { prompt.close(); }
  assert.equal(point.length, 2);
  assert.ok(point.every(Number.isFinite));
  await call("click", { ...target, x: point[0], y: point[1], from_zoom: true, delivery_mode: "background" });
  state = await snapshot();
  assert.ok(JSON.stringify(state).includes("Selections: 5"));
  await call("get_window_state", { ...target, max_image_dimension: 500, include_accessibility_tree: false });
  await call("browser_pointer", { ...page, action: "hover", ref: find("Next local page"), delivery_mode: "background" });
  await call("browser_pointer", { ...page, action: "scroll", x: 300, y: 300, delta_y: 700, delivery_mode: "background" });
  await call("get_window_state", { ...target, max_image_dimension: 500, include_accessibility_tree: false });
  await call("browser_navigate", { ...page, url: url + "next" });
  state = await snapshot();
  assert.ok(JSON.stringify(state).includes("Next local page reached"));
  await call("get_window_state", { ...target, max_image_dimension: 500, include_accessibility_tree: false });
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  try { if (started) await call("end_session", {}); }
  finally {
    try { await client.close(); }
    finally {
      await transport.close();
      await new Promise(resolve => server.close(resolve));
      await writeFile(`${directory}/stderr.log`, stderr);
    }
  }
}
