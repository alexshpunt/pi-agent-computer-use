import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { ComputerSession } from "../src/session.ts";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { finishProfile } from "../src/browser-profile.ts";
import { createUiResourcesSite } from "../test/fixtures/ui-resources-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { accountNativeTrace } from "./native-observe-accounting.ts";

// Explicit qualification of separate bytes; this never changes production config.
assert.ok(process.argv.includes("--owned-input"), "Authorize only new owned fixture input with --owned-input.");
assert.ok(process.argv.includes("--private-displays"), "Read-only private monitor qualification requires --private-displays.");
const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(plan.base, "ab86b25cba1cb9c6f5025f25fdd7a8cb3cd21a44");
assert.equal(plan.candidate.source, "4825375a7d7827cd5dcf0f34924aa45611533853");
assert.equal(plan.traceBaseline.source, "3c78d8c36a3cd22be1dd12f0323a18a280f4b1dd");
assert.equal(plan.diagnostic.source, "21887ef112b500d7e60aa12fbe366c59e0c3de38");
const configFile = path.resolve(plan.baselineConfig);
const configBytes = await readFile(configFile);
const baselineConfig = await loadComputerConfig(path.dirname(path.dirname(configFile)));
assert.ok(plan.interop === undefined || (typeof plan.interop === "string" && plan.interop.startsWith("/run/WSL/")));
// A live endpoint may be supplied for this experiment without rewriting installed config.
const config = { ...baselineConfig, ...(plan.interop ? { interop: plan.interop } : {}) };
assert.equal(config.runtime, "windows-semantic-actions");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const baselineHash = sha(await readFile(config.command));
assert.equal(baselineHash, "17cf450b3e202b9f4b4153133dfb8f4bc3d8121c5f2d0246a6c3ec78e3f49185");
const directory = `.tmp/fast-bilinear/qualification-${Date.now()}`;
await mkdir(directory, { recursive: true });
const baseline = new McpDriver(config);
const staged = [], samples = [], hits = [], details = [], delivery = [], displays = [], clients = [];
const abort = new AbortController();
const interrupt = () => abort.abort(); process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);

class CandidateClient {
  client; transport; queue = []; lines = ""; wait; failure; request = 0;
  constructor(command, trace) { this.command = command; this.trace = trace; }
  async connect() {
    this.transport = new StdioClientTransport({ command: this.command, args: ["mcp", "--direct", "--embedded"], stderr: "pipe", env: {
      WSL_INTEROP: config.interop ?? process.env.WSL_INTEROP,
      WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "CUA_DRIVER_MCP_ENVELOPES", "DO_NOT_TRACK"].filter(Boolean).join(":"),
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", CUA_DRIVER_MCP_ENVELOPES: "1", DO_NOT_TRACK: "1",
    } });
    if (this.trace) this.transport.stderr.on("data", chunk => {
      try {
        this.lines += chunk.toString(); assert.ok(this.lines.length < 65536);
        let end;
        while ((end = this.lines.indexOf("\n")) >= 0) {
          const line = this.lines.slice(0, end); this.lines = this.lines.slice(end + 1);
          if (!line.startsWith("CUA_NATIVE_PROFILE ")) continue;
          const trace = JSON.parse(line.slice("CUA_NATIVE_PROFILE ".length)); accountNativeTrace(trace);
          if (this.wait) { const next = this.wait; this.wait = undefined; next.resolve(trace); }
          else { assert.ok(this.queue.length < 2); this.queue.push(trace); }
        }
      } catch (error) { this.failure = error; this.wait?.reject(error); }
    });
    this.client = new Client({ name: "pi-bilinear-qualification", version: "0.0.0" });
    await this.client.connect(this.transport, { signal: abort.signal, timeout: 15000 });
    assert.deepEqual(this.client.getServerVersion(), { name: "cua-driver", version: "0.34.0" });
    assert.equal(this.client.getServerCapabilities()?.experimental?.["ai.cua.driver.envelopes"]?.version, 1);
  }
  async call(name, args, signal = abort.signal) {
    if (this.failure) throw this.failure;
    return CallToolResultSchema.parse(await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 15000 }));
  }
  async traceReport() {
    if (this.failure) throw this.failure;
    if (this.queue.length) return this.queue.shift();
    let timer;
    try { return await new Promise((resolve, reject) => { this.wait = { resolve, reject }; timer = setTimeout(() => reject(Error("Missing trace; no request replay.")), 2000); }); }
    finally { clearTimeout(timer); this.wait = undefined; }
  }
  async close() { try { await this.client?.close(); } finally { await this.transport?.close(); } }
}

async function prepare(entry, traced) {
  const artifact = path.resolve(entry.directory);
  assert.ok(artifact.startsWith(path.resolve(".tmp/fast-bilinear") + path.sep));
  assert.equal((await readFile(path.join(artifact, "source-sha.txt"), "utf8")).trim(), entry.source);
  const hashes = JSON.parse(await readFile(path.join(artifact, "hashes.json"), "utf8"));
  assert.equal(hashes.length, 3);
  for (const row of hashes) {
    assert.ok(["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"].includes(row.name));
    const hash = sha(await readFile(path.join(artifact, "runtime", row.name)));
    assert.equal(hash, row.Hash.toLowerCase());
    if (row.name === "cua-driver.exe") assert.equal(hash, entry.sha256);
  }
  const target = path.join(path.dirname(config.command), ".tmp", "lpt-663", `${entry.source}-${Date.now()}`);
  await cp(path.join(artifact, "runtime"), target, { recursive: true, force: false, errorOnExist: true }); staged.push(target);
  const client = new CandidateClient(path.join(target, "cua-driver.exe"), traced); clients.push(client); await client.connect(); return client;
}

// Position only the exact owned fixture and request top z-order without activation.
// This does not guarantee visible or painted content; inspect the returned pixels.
function position(target, x, y, w, h) {
  const code = `Add-Type 'using System;using System.Runtime.InteropServices;public class OwnedSinglePng {
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int t,uint f); }';
if([OwnedSinglePng]::SetThreadDpiAwarenessContext([IntPtr](-4))-eq[IntPtr]::Zero){throw 'Physical coordinates required'};
[uint32]$p=0;[void][OwnedSinglePng]::GetWindowThreadProcessId([IntPtr]${target.window_id},[ref]$p);if($p-ne${target.pid}){throw 'Owned identity changed'};
if(-not[OwnedSinglePng]::SetWindowPos([IntPtr]${target.window_id},[IntPtr]::Zero,${x},${y},${w},${h},16)){throw 'Owned positioning failed'};`;
  execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(code, "utf16le").toString("base64")], { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
}
const median = list => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null; };
const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
let site, fixture, session, candidate, traceBaseline, diagnostic, completed = false, cleanup;
try {
  candidate = await prepare(plan.candidate, false);
  traceBaseline = await prepare(plan.traceBaseline, true);
  diagnostic = await prepare(plan.diagnostic, true);
  site = await createUiResourcesSite();
  const root = path.dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
  fixture = await openCompleteInputWindow(baseline, site.url, root);
  position(fixture.target, 40, 50, 1600, 1200);
  const start = performance.now();
  const modes = ["image_500", "image_native", "full_500", "ui_only"];
  const observe = async (runtime, mode, phase) => {
    assert.ok(!abort.signal.aborted && performance.now() - start < 240000);
    const driver = { baseline, candidate, traceBaseline, diagnostic }[runtime];
    const options = { ...fixture.target, include_accessibility_tree: mode === "full_500" || mode === "ui_only", include_screenshot: mode !== "ui_only", max_image_dimension: mode === "image_native" ? 0 : 500 };
    const t = performance.now(); const result = await driver.call("get_window_state", options); const wall = performance.now() - t;
    assert.ok(!result.isError && !result.structuredContent?.screenshot_error, "Owned capture failed; stop.");
    const images = result.content.filter(c => c.type === "image"); assert.equal(images.length, mode === "ui_only" ? 0 : 1);
    assert.equal(Array.isArray(result.structuredContent?.elements), options.include_accessibility_tree);
    const row = { runtime, mode, phase, wall_ms: wall };
    if (images.length) {
      const bytes = Buffer.from(images[0].data, "base64"); assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      row.dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; row.png_bytes = bytes.length;
      if (mode !== "image_native") assert.ok(Math.min(row.dimensions.width, row.dimensions.height) > 0 && Math.max(row.dimensions.width, row.dimensions.height) <= 500);
      if (runtime === "candidate" && mode === "full_500" && phase === "setup") await writeFile(`${directory}/overview.png`, bytes);
    }
    if (runtime === "diagnostic" || runtime === "traceBaseline") {
      row.trace = await driver.traceReport(); assert.equal(row.trace.request, ++driver.request);
      row.accounting = accountNativeTrace(row.trace);
      if (mode === "image_500" || mode === "full_500") {
        const labels = row.trace.events.map(event => event.name);
        assert.equal(labels.filter(label => label === "image.final_PNG_encode").length, 1);
        assert.equal(labels.filter(label => label === (runtime === "diagnostic" ? "image.Bilinear" : "image.Lanczos3")).length, 1);
        assert.ok(!labels.includes("image.native_PNG_encode") && !labels.includes("image.PNG_decode"), "No intermediate PNG round trip.");
      }
    }
    samples.push(row);
  };
  for (const mode of modes) for (const runtime of ["baseline", "candidate", "traceBaseline", "diagnostic"]) await observe(runtime, mode, "setup");
  for (let i = 0; i < 10; i++) for (const mode of modes) for (const runtime of i % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) await observe(runtime, mode, "warm");
  for (let i = 0; i < 10; i++) for (const runtime of i % 2 ? ["diagnostic", "traceBaseline"] : ["traceBaseline", "diagnostic"]) await observe(runtime, "image_500", "warm");
  assert.equal(site.events().length, 0, "Timing probes send no input.");
  for (const mode of modes) assert.equal(new Set(samples.filter(s => s.mode === mode && s.dimensions).map(s => JSON.stringify(s.dimensions))).size, mode === "ui_only" ? 0 : 1);
  const file = path.join(staged[0], "owned-file.png");
  const windowsFile = file.replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
  const disk = await candidate.call("get_window_state", { ...fixture.target, include_accessibility_tree: false, include_screenshot: false, screenshot_out_file: windowsFile, max_image_dimension: 500 });
  assert.ok(!disk.isError && !disk.structuredContent?.screenshot_error);
  assert.equal(disk.content.filter(c => c.type === "image").length, 0);
  const diskPng = await readFile(file); assert.equal(diskPng.subarray(1, 4).toString(), "PNG");
  // The retained two-step aspect rounding may undershoot the cap by one pixel.
  const diskWidth = diskPng.readUInt32BE(16), diskHeight = diskPng.readUInt32BE(20);
  assert.ok(Math.min(diskWidth, diskHeight) > 0 && Math.max(diskWidth, diskHeight) <= 500);
  const baselineFile = path.join(staged[1], "owned-baseline-file.png");
  const baselineDisk = await baseline.call("get_window_state", { ...fixture.target, include_accessibility_tree: false, include_screenshot: false, screenshot_out_file: baselineFile.replace("/mnt/c/", "C:\\").replaceAll("/", "\\"), max_image_dimension: 500 });
  assert.ok(!baselineDisk.isError && !baselineDisk.structuredContent?.screenshot_error);
  const baselinePng = await readFile(baselineFile);
  assert.deepEqual([diskWidth, diskHeight], [baselinePng.readUInt32BE(16), baselinePng.readUInt32BE(20)], "File delivery must preserve baseline dimensions.");
  delivery.push({ mode: "file_forced_without_tree_or_embedded_image", width: diskPng.readUInt32BE(16), height: diskPng.readUInt32BE(20), verified: true });
  // Read only explicitly authorized monitors. Full pixels stay in this private
  // directory; the report contains dimensions and hashed source identities only.
  const listedDisplays = await candidate.call("list_displays", {});
  assert.ok(!listedDisplays.isError);
  const topology = listedDisplays.structuredContent;
  assert.ok(topology?.platform === "windows" && typeof topology.topology_id === "string");
  assert.ok(Array.isArray(topology.displays) && topology.displays.length > 0);
  const primary = topology.displays.find(d => d.primary);
  assert.ok(primary);
  const selected = topology.displays.find(d => !d.primary) ?? primary;
  const sources = [{ kind: "primary", display: primary }, { kind: "selected", display: selected }];
  for (const source of sources) {
    const bounds = source.display.bounds;
    position(fixture.target, bounds.x + 20, bounds.y + 20, Math.min(1400, bounds.width - 40), Math.min(1000, bounds.height - 40));
    for (let round = 0; round < 3; round++) for (const cap of [500, 0]) {
      const pair = [];
      for (const runtime of round % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
        assert.ok(!abort.signal.aborted && performance.now() - start < 240000);
        const driver = runtime === "candidate" ? candidate : baseline;
        const name = source.kind === "primary" ? "get_desktop_state" : "get_display_state";
        const args = source.kind === "primary" ? { max_image_dimension: cap } :
          { display_id: source.display.display_id, topology_id: topology.topology_id, max_image_dimension: cap };
        const t = performance.now();
        const result = await driver.call(name, args);
        const wall = performance.now() - t;
        assert.ok(!result.isError);
        const state = result.structuredContent;
        assert.equal(state.platform, "windows");
        if (source.kind === "selected") {
          assert.equal(state.topology_id, topology.topology_id);
          assert.equal(state.display.display_id, source.display.display_id);
        } else assert.equal(state.display, "primary");
        const images = result.content.filter(c => c.type === "image");
        assert.equal(images.length, 1); assert.equal(images[0].mimeType, "image/png");
        const bytes = Buffer.from(images[0].data, "base64");
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        assert.equal(state.screenshot_width, width); assert.equal(state.screenshot_height, height);
        if (cap === 0) assert.deepEqual([width, height], [bounds.width, bounds.height]);
        else assert.ok(Math.min(width, height) > 0 && Math.max(width, height) <= 500);
        if (runtime === "candidate" && cap === 500 && round === 0)
          await writeFile(`${directory}/private-display-${source.kind}.png`, bytes);
        pair.push([width, height]);
        displays.push({ source: source.kind, source_hash: sha(Buffer.from(source.display.display_id)),
          selected_is_primary: source.kind === "selected" && source.display.primary,
          runtime, cap, round, width, height, wall_ms: wall, read_only: true });
      }
      assert.deepEqual(pair[0], pair[1]);
    }
  }
  const qualified = new McpDriver({ ...config, command: path.join(staged[0], "cua-driver.exe"), runtime: "windows-fast-bilinear" });
  clients.push(qualified);
  assert.equal(qualified.overviewKernel, "bilinear");
  const adapter = { call: (...args) => qualified.call(...args), identity: (...args) => qualified.identity(...args), close: () => qualified.close(), heldPaths: qualified.heldPaths, heldKeys: qualified.heldKeys, selectedDisplays: qualified.selectedDisplays, captureBoundDrag: qualified.captureBoundDrag, semanticActions: qualified.semanticActions, overviewKernel: qualified.overviewKernel };
  session = new ComputerSession(adapter, undefined, () => ({ maxLongEdge: 500, scale: 1, hints: false }));
  const listed = await session.windows(); const found = listed.details.state.windows.filter(w => w.pid === fixture.target.pid && w.window_id === fixture.target.window_id);
  assert.equal(found.length, 1); const ref = found[0].window_ref;
  for (const [name, geometry] of [["baseline", [40, 50, 1600, 1200]], ["move", [180, 140, 1600, 1200]], ["resize", [180, 140, 1760, 1320]]]) {
    position(fixture.target, ...geometry);
    const view = await session.observe(ref); assert.equal(view.details.status, "observed");
    const controls = view.details.ui.elements.filter(e => e.name === "Canvas" && e.bounds.window_image && e.enabled !== false); assert.equal(controls.length, 1);
    const r = controls[0].bounds.window_image; const point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    const before = site.events().length;
    const acted = await session.act({ window_ref: ref, observation_id: view.details.observation_id, action: "click", ...point });
    assert.equal(acted.details.status, "delivered", "Uncertain input is not replayed.");
    let pointer;
    for (let n = 0; n < 6; n++) { await session.observe(ref); pointer = site.events().slice(before).find(e => e.type === "pointer"); if (pointer) break; }
    assert.ok(pointer && site.events().slice(before).some(e => e.type === "click"));
    const value = pointer.value; const dx = value.x - value.center_x, dy = value.y - value.center_y;
    const tolerance = Math.ceil(controls[0].bounds.native_screen.width / r.width / value.dpr) + 1;
    assert.ok(Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance);
    hits.push({ case: name, dx, dy, tolerance, domain: "app_client_css_pixels", dpr: value.dpr, coordinate_grounding: acted.details.state?.coordinate_grounding });
    const prior = await session.observe(ref); assert.equal(prior.details.status, "observed");
    position(fixture.target, geometry[0] + 20, geometry[1] + 20, geometry[2] - 80, geometry[3] - 60);
    const roi = { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.floor(r.width), height: Math.floor(r.height) };
    const detail = await session.observe(ref, undefined, undefined, { image_id: prior.details.agent_image.image_id, ...roi });
    assert.equal(detail.details.status, "observed"); assert.equal(detail.details.source.capabilities.input, "none");
    assert.deepEqual(detail.details.agent_image.region.overview, { image_id: prior.details.agent_image.image_id, dimensions: prior.details.source.image.dimensions, ...roi });
    details.push({ case: name, route: detail.details.agent_image.route, source: detail.details.source.image, original_region: roi });
  }
  const monitors = await session.displays();
  assert.equal(monitors.details.status, "listed");
  const addressed = monitors.details.state.displays;
  const selectedRef = addressed.find(d => d.display_id === selected.display_id).display_ref;
  for (const ref of ["primary", selectedRef]) {
    const view = await session.observeDisplay(ref);
    assert.equal(view.details.status, "observed");
    assert.equal(view.details.source.capabilities.input, "none");
    assert.equal(view.details.observation_id, undefined);
    const detail = await session.observeDisplay(ref, undefined, {
      image_id: view.details.agent_image.image_id, x: 10, y: 10, width: 50, height: 50,
    });
    assert.equal(detail.details.status, "observed");
    assert.equal(detail.details.source.capabilities.input, "none");
    details.push({ case: `display_${ref === "primary" ? "primary" : "selected"}`,
      route: detail.details.agent_image.route, read_only: true });
  }
  const safe = new ComputerSession({
    ...adapter, call: async () => { throw Error("Safe display read reached native runtime."); },
    close: async () => {},
  }, () => "safe");
  assert.equal((await safe.displays()).details.status, "refused");
  assert.equal((await safe.observeDisplay("primary")).details.status, "refused");
  assert.equal((await safe.observeDisplay(selectedRef)).details.status, "refused");
  await safe.close();
  const resizeRows = runtime => samples.filter(s => s.runtime === runtime && s.mode === "image_500" && s.phase === "warm");
  assert.ok(median(resizeRows("diagnostic").map(s => s.accounting.inclusive_us["image.Bilinear"])) <
    median(resizeRows("traceBaseline").map(s => s.accounting.inclusive_us["image.Lanczos3"])), "Native resize median did not improve.");
  assert.equal(hits.length, 3); assert.equal(details.length, 5); assert.equal(displays.length, 24); completed = true;
} catch (error) { await writeFile(`${directory}/private-failure.txt`, error instanceof Error ? error.stack ?? error.message : String(error)); console.error("Bilinear qualification stopped; no input replay."); }
finally {
  cleanup = await finishProfile(completed, { fixture: async () => { assert.ok(fixture); const c = await fixture.close(); assert.ok(c.sourceGone && c.profileRemoved); }, session: async () => { await session?.close(); }, clients: async () => { for (const c of clients) await c.close(); await baseline.close(); }, site: async () => { await site?.close(); }, candidate_files: async () => { for (const d of staged) await rm(d, { recursive: true, force: true }); } });
  assert.deepEqual(await readFile(configFile), configBytes); assert.equal(sha(await readFile(config.command)), baselineHash);
  const summary = ["image_500", "image_native", "full_500", "ui_only"].map(mode => ({ mode, baseline_mean_ms: mean(samples.filter(s => s.runtime === "baseline" && s.phase === "warm" && s.mode === mode).map(s => s.wall_ms)), candidate_mean_ms: mean(samples.filter(s => s.runtime === "candidate" && s.phase === "warm" && s.mode === mode).map(s => s.wall_ms)) }));
  const resizeSummary = ["traceBaseline", "diagnostic"].map(runtime => {
    const label = runtime === "diagnostic" ? "image.Bilinear" : "image.Lanczos3";
    const rows = samples.filter(s => s.runtime === runtime && s.mode === "image_500" && s.phase === "warm");
    const values = rows.map(s => s.accounting.inclusive_us[label] / 1000);
    return { runtime, label, count: rows.length, median_ms: median(values), mean_ms: mean(values),
      boundary: "native resize, including destination allocation; excludes PNG and capture" };
  });
  const report = { schema: 1, success: cleanup.success, base: plan.base, candidate: plan.candidate, traceBaseline: plan.traceBaseline, diagnostic: plan.diagnostic, boundary: "SDK call receipt, not compositor frame age", config_unchanged: true, baseline_sha256: baselineHash, samples, summary, resizeSummary, hits, details, delivery, displays, cleanup: cleanup.cleanup };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ success: report.success, samples: samples.length, hits: hits.length, details: details.length, summary, resizeSummary, display_samples: displays.length, cleanup: cleanup.cleanup, report: `${directory}/report.json` }));
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); if (!report.success) process.exitCode = 1;
}
