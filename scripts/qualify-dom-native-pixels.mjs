import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { nativeWindowState } from "./native-window-state.mjs";
import { assertSelectedBridgeTab } from "./owned-browser-bridge-contract.mjs";
import { assertReadonlyPixelHistory, assertReadonlyPixelWitness, closePixelProbeServer, validatePixelProbeReport } from "./dom-native-pixel-contract.mjs";
import { MARKERS, verifyMarkerRaster } from "./dom-marker-geometry.mjs";
import { createDomPixelPage } from "./fixtures/dom-marker-page.mjs";
import { validateDomSnapshot } from "../src/dom-inspection.ts";
import { validateDomGeometry } from "../src/dom-geometry.ts";
import sharp from "sharp";

// Bounded research: one isolated CUA-owned page, private CDP pixels and native captures.
// It never dispatches browser input, selects tabs, or exposes page pixels as native pixels.
const cssomMarkers = process.argv.includes("--cssom-markers");
assert.deepEqual(process.argv.slice(2), cssomMarkers ? ["--live-approved", "--cssom-markers"] : ["--live-approved"]);
const command = process.env.CUA_DRIVER_PATH, expected = process.env.CUA_DRIVER_SHA256;
assert.ok(command?.endsWith(".exe")); assert.match(expected ?? "", /^[a-f0-9]{64}$/);
assert.ok(process.env.WSL_INTEROP && (await stat(process.env.WSL_INTEROP)).isSocket());
const hash = createHash("sha256").update(await readFile(command)).digest("hex"); assert.equal(hash, expected);
const directory = `.tmp/lpt-733/pixels-${Date.now()}`, nonce = randomUUID(), session = `pi-dom-pixels-${randomUUID()}`;
const title = `Pi DOM pixel proof ${nonce.slice(0, 8)}`;
await mkdir(directory, { recursive: true });
const pendingReports = new Set();
const reports = [], records = [], geometrySamples = { before: [], after: [] }, rasterProofs = [];
let target, page, profile, started = false, stopping = false, navigated = false, rejected = 0, stderr = "";
const html = createDomPixelPage({ title, nonce, cssomMarkers });
const server = createServer((request, response) => {
  const handling = handleRequest(request, response);
  pendingReports.add(handling);
  void handling.then(() => pendingReports.delete(handling), () => { pendingReports.delete(handling); rejected++; });
});
async function handleRequest(request, response) {
  if (request.method === "GET" && request.url === "/") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return; }
  if (request.method !== "POST" || request.url !== "/witness") { response.writeHead(404).end(); return; }
  try {
    let body = ""; for await (const chunk of request) { body += chunk; assert.ok(body.length <= 8192); }
    const report = validatePixelProbeReport(JSON.parse(body), nonce); assert.ok(reports.length < 1000);
    reports.push({ ...report, received_ms: Date.now() }); response.writeHead(204).end();
  } catch { rejected++; response.writeHead(400).end(); }
}
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const transport = new StdioClientTransport({ command, args: ["mcp", "--direct", "--embedded"], stderr: "pipe", env: {
  WSL_INTEROP: process.env.WSL_INTEROP, WSLENV: [process.env.WSLENV,"CUA_DRIVER_RS_TELEMETRY_ENABLED","CUA_DRIVER_RS_UPDATE_CHECK","DO_NOT_TRACK"].filter(Boolean).join(":"),
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", DO_NOT_TRACK: "1" } });
transport.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
const client = new Client({ name: "pi-dom-native-pixel-research", version: "0.0.0" });
const save = () => writeFile(`${directory}/run.json`, JSON.stringify({ hash, session, url, target, page, profile, records, reports, rejected, geometrySamples, rasterProofs }, null, 2) + "\n");
async function call(label, name, args = {}) {
  assert.ok(!stopping || name === "end_session", "Stop/deadline prevents later dispatch.");
  assert.ok(records.length < 128 || name === "end_session", "Bounded native-call journal exhausted.");
  assert.ok(["start_session","end_session","browser_prepare","list_windows","get_browser_state","browser_navigate","get_window_state"].includes(name));
  if (name === "browser_navigate") {
    assert.equal(args.url, url, "Only owned fixture setup navigation.");
    assert.equal(navigated, false, "No navigation replay or browser replacement."); navigated = true;
  }
  const start = performance.now();
  let result;
  try { result = await client.callTool({ name, arguments: { ...args, session } }, undefined, { timeout: 30_000 }); }
  catch (error) { records.push({ label, name, args, error: String(error), outcome: "unknown; no replay" }); await save(); throw error; }
  const images = [];
  for (const [index, block] of (result.content ?? []).entries()) if (block.type === "image") {
    assert.equal(block.mimeType, "image/png"); const file = `${label}-${index}.png`;
    await writeFile(`${directory}/${file}`, Buffer.from(block.data, "base64")); images.push(file);
  }
  records.push({ label, name, args, elapsed_ms: performance.now() - start, structuredContent: result.structuredContent,
    isError: result.isError ?? false, text: (result.content ?? []).filter(block => block.type === "text").map(block => block.text), images });
  await save(); console.log(JSON.stringify({ directory, ...records.at(-1) }));
  if (name === "get_browser_state" && args.snapshot_format === "dom_inspect_v1")
    assert.equal(images.length, 0, "Readonly DOM/geometry must not acquire pixels implicitly.");
  if (name === "get_window_state") assert.equal(images.length, 1, "Require one exact native window raster.");
  assert.ok(!result.isError && result.structuredContent?.status !== "refused" && !result.structuredContent?.refusal && !result.structuredContent?.error,
    "Native refusal stops this probe without fallback/replay."); return result;
}
async function selected(label) {
  const state = (await call(label, "get_browser_state", target)).structuredContent;
  assertSelectedBridgeTab(state, url, title);
}
async function witness(label) {
  for (let i = 0; i < 30 && (!reports.length || Date.now() - reports.at(-1).received_ms > 5000); i++) await delay(100);
  const report = assertReadonlyPixelWitness(reports, nonce, url, rejected);
  const native = await nativeWindowState(process.env.WSL_INTEROP, [target]);
  assert.equal(native.status, "measured"); assert.equal(native.windows[0].exists, true);
  const record = { label, report, native }; await writeFile(`${directory}/${label}.json`, JSON.stringify(record, null, 2) + "\n");
  return record;
}
function markerWitness(report) {
  assert.equal(report.viewport.scrollX, 0); assert.equal(report.viewport.scrollY, 0);
  assert.ok(Array.isArray(report.markers) && report.markers.length === MARKERS.length);
  for (const marker of MARKERS) {
    const rows = report.markers.filter(row => row.id === marker.id);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].bounds, marker.css, "Require the declared synthetic CSS layout, not an inferred transform.");
  }
}
async function sampleMarkerGeometry(phase) {
  for (const marker of MARKERS) {
    await selected(`marker-${phase}-${marker.id}-selected`);
    const snapshot = validateDomSnapshot((await call(`marker-${phase}-${marker.id}-snapshot`, "get_browser_state",
      { ...page, snapshot_format: "dom_inspect_v1", include_screenshot: false, include_hidden: true,
        max_nodes: 20, max_depth: 16, locator: { test_id: marker.id } })).structuredContent, page, 20);
    const rows = snapshot.elements.filter(row => row.attributes.id === marker.id && row.frame.kind === "main");
    assert.equal(rows.length, 1, "Require one exact main-document marker ref.");
    const sample = validateDomGeometry((await call(`marker-${phase}-${marker.id}-geometry`, "get_browser_state",
      { ...page, snapshot_format: "dom_inspect_v1", geometry_ref: rows[0].ref })).structuredContent, page, rows[0].ref);
    const independent = await witness(`marker-${phase}-${marker.id}-witness`);
    markerWitness(independent.report);
    assert.deepEqual(sample.bounds, independent.report.markers.find(row => row.id === marker.id).bounds);
    assert.deepEqual(sample.scroll, { x: 0, y: 0 });
    geometrySamples[phase].push({ id: marker.id, bounds: sample.bounds });
    await selected(`marker-${phase}-${marker.id}-selected-after`);
  }
  await save();
}
async function verifyPrivateMarkerImages(before, final) {
  markerWitness(before.report); markerWitness(final.report);
  assert.deepEqual(final.report.viewport, before.report.viewport, "The fixture viewport changed during sampling.");
  assert.deepEqual(geometrySamples.before, geometrySamples.after);
  let first;
  for (const phase of ["before", "after"]) {
    const images = records.find(record => record.label === `native_view-${phase}`)?.images;
    assert.equal(images?.length, 1);
    const png = await readFile(`${directory}/${images[0]}`);
    assert.ok(png.length <= 32 * 1024 * 1024 && png.length >= 26 && png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    assert.equal(png[24], 8, "Only original eight-bit PNG samples are admitted.");
    assert.ok([2, 6].includes(png[25]), "Only truecolor PNG samples are admitted.");
    const { data, info } = await sharp(png, { limitInputPixels: 16_000_000, ignoreIcc: true })
      .ensureAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    const proof = verifyMarkerRaster(data, info.width, info.height, geometrySamples[phase], before.report.viewport.dpr);
    if (first) {
      assert.equal(info.width, first.width); assert.equal(info.height, first.height);
      assert.ok(data.equals(first.data), "Private page rasters changed; no atomic or current native proof is inferred.");
    } else first = { width: info.width, height: info.height, data };
    rasterProofs.push({ phase, ...proof });
  }
  await save();
}
async function ownedProfile(pid) {
  const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if(!$p){throw 'Owned process gone'};$p.CommandLine`;
  const { stdout } = await promisify(execFile)("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")], { timeout: 10_000, env: { ...process.env, WSL_INTEROP: process.env.WSL_INTEROP } });
  const match = stdout.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/); assert.ok(match);
  const windowsPath = match[1] ?? match[2]; assert.match(windowsPath, /^[A-Za-z]:\\/);
  const local = `/mnt/${windowsPath[0].toLowerCase()}/${windowsPath.slice(3).replaceAll("\\", "/")}`;
  assert.ok((await stat(local)).isDirectory()); return { windowsPath, local };
}
const stop = () => { stopping = true; process.exitCode = 1; };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const lifetime = setTimeout(stop, 180_000);
try {
  await client.connect(transport, { timeout: 15_000 }); assert.equal(client.getServerVersion()?.name, "cua-driver");
  const tools = await client.listTools(undefined, { timeout: 15_000 });
  await writeFile(`${directory}/tools-list.json`, JSON.stringify(tools, null, 2) + "\n");
  assert.ok(!tools.nextCursor, "Tool discovery must be complete before launching an owned browser.");
  const stateTool = tools.tools.find(tool => tool.name === "get_browser_state");
  assert.deepEqual(stateTool?.inputSchema?.properties?.screenshot_mode?.enum, ["viewport", "surface_unclipped", "native_view"], "Candidate must advertise explicit no-clip capture modes.");
  if (cssomMarkers) assert.ok(stateTool.inputSchema.properties.geometry_ref, "CSS marker mode needs explicit readonly geometry before owned launch.");
  // A lost acknowledgement can still leave the named session alive; cleanup must try it once.
  started = true; await call("start", "start_session");
  const prepared = (await call("prepare", "browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } })).structuredContent;
  assert.equal(prepared.prepared, true); assert.ok(Number.isSafeInteger(prepared.prepared_pid) && prepared.prepared_pid > 0);
  profile = await ownedProfile(prepared.prepared_pid);
  const windows = (await call("windows", "list_windows", { pid: prepared.prepared_pid })).structuredContent.windows;
  assert.equal(windows.length, 1); target = { pid: windows[0].pid, window_id: windows[0].window_id }; assert.equal(target.pid, prepared.prepared_pid);
  const bound = (await call("bind", "get_browser_state", target)).structuredContent;
  assert.equal(bound.binding_quality, "exact"); assert.equal(bound.tabs.length, 1); assert.equal(bound.tabs[0].active, true);
  page = { target_id: bound.target_id, tab_id: bound.tabs[0].tab_id };
  await call("fixture-navigation", "browser_navigate", { ...page, url });
  const before = await witness("baseline"); await selected("selected-before");
  const capture = async (mode, phase) => {
    await selected(`selected-${mode}-${phase}`);
    const result = await call(`${mode}-${phase}`, "get_browser_state", { ...page, snapshot_format: "semantic_v2", include_screenshot: true, screenshot_mode: mode });
    assert.equal(result.structuredContent.page.url, url);
    assert.equal(result.content.filter(block => block.type === "image").length, 1);
    const metadata = result.structuredContent.screenshot;
    assert.equal(metadata.source, "cdp_tab"); assert.equal(metadata.capture_mode, mode);
    for (const key of ["coordinate_space", "viewport_css_width", "viewport_css_height", "pixel_to_css_scale_x", "pixel_to_css_scale_y"]) {
      assert.equal(Object.hasOwn(metadata, key), false, "Unqualified view/surface pixels must not claim CSS geometry.");
    }
    await selected(`selected-${mode}-${phase}-after`);
  };
  if (cssomMarkers) await sampleMarkerGeometry("before");
  else await capture("surface_unclipped", "before");
  await capture("native_view", "before");
  await call("native-wgc", "get_window_state", { ...target, capture_backend: "wgc", include_accessibility_tree: false, max_image_dimension: 4096 });
  await selected("selected-after-wgc");
  // Default route contains the existing PrintWindow/GDI path and may use native fallbacks.
  // Record its actual metadata; never label it pure PrintWindow without evidence.
  await call("native-default", "get_window_state", { ...target, include_accessibility_tree: false, max_image_dimension: 4096 });
  await selected("selected-after-default");
  if (!cssomMarkers) await capture("surface_unclipped", "after");
  await capture("native_view", "after");
  if (cssomMarkers) await sampleMarkerGeometry("after");
  await selected("selected-final");
  const final = await witness("final"); assert.deepEqual(final.native.pointer, before.native.pointer, "Physical pointer changed during readonly sampling.");
  if (cssomMarkers) await verifyPrivateMarkerImages(before, final);
  console.log(JSON.stringify({ directory, sampling_complete: true, witness_integrity: "pending owned shutdown", proof: "pending final history integrity and exact offline RGB comparison; not atomic geometry or acceptance" }));
} finally {
  const cleanup = {};
  try { if (started) { await call("end", "end_session"); cleanup.sessionEnded = true; } }
  catch (error) { cleanup.end_error = String(error); process.exitCode = 1; }
  clearTimeout(lifetime);
  try {
    if (target && profile) {
      for (let i = 0; i < 10; i++) {
        cleanup.native = await nativeWindowState(process.env.WSL_INTEROP, [target]);
        cleanup.profileExists = await stat(profile.local).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
        if (cleanup.native.status === "measured" && !cleanup.native.windows[0].exists && !cleanup.profileExists) break;
        await delay(100);
      }
      assert.equal(cleanup.native.status, "measured"); assert.equal(cleanup.native.windows[0].exists, false); assert.equal(cleanup.profileExists, false);
    } else if (started) { cleanup.verification = "Exact owned source unavailable"; process.exitCode = 1; }
  } catch (error) { cleanup.verification_error = String(error); process.exitCode = 1; }
  const releases = await Promise.allSettled([(async () => { try { await client.close(); } finally { await transport.close(); } })(), closePixelProbeServer(server)]);
  cleanup.release_errors = releases.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  if (cleanup.release_errors.length) process.exitCode = 1;
  // No new connections remain; let aborted/in-flight request handlers finish before sealing evidence.
  const handlers = await Promise.allSettled([...pendingReports]);
  cleanup.release_errors.push(...handlers.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []));
  try {
    assertReadonlyPixelHistory(reports, nonce, url, rejected);
    cleanup.witness_integrity = true;
  } catch (error) {
    cleanup.witness_integrity = false; cleanup.witness_error = String(error); process.exitCode = 1;
  }
  if (cleanup.release_errors.length) process.exitCode = 1;
  await save(); await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2) + "\n"); await writeFile(`${directory}/stderr.log`, stderr);
  console.log(JSON.stringify({ directory, cleanup })); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
}
