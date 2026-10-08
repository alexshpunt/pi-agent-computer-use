import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { finishProfile } from "../src/browser-profile.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { createWindowCaptureSite } from "../test/fixtures/window-capture-site.ts";
import { accountNativeTrace } from "./native-observe-accounting.ts";

// Supporting native experiment, not canonical CUA certification or runtime adoption.
// All four timing variants are read-only. In particular WGC pixels do not qualify input geometry.
assert.ok(process.argv.includes("--owned-fixture"), "Authorize one new disposable fixture with --owned-fixture.");
const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
const roles = ["baseline", "direct", "wgc", "wgcPoll5"];
assert.deepEqual(Object.keys(plan.variants).sort(), [...roles].sort());
const configFile = path.resolve(plan.config);
const configBytes = await readFile(configFile);
const config = { ...await loadComputerConfig(path.dirname(path.dirname(configFile))), ...(plan.interop ? { interop: plan.interop } : {}) };
assert.equal(config.runtime, "windows-fast-bilinear");
assert.ok(typeof config.interop === "string" && /^\/run\/WSL\/\d+_interop$/.test(config.interop));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const installedHash = hash(await readFile(config.command));
assert.equal(installedHash, plan.installed_sha256);
const directory = path.resolve(`.tmp/window-capture-latency/run-${Date.now()}`);
await mkdir(directory, { recursive: true });
const abort = new AbortController();
const interrupt = () => abort.abort();
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const deadline = performance.now() + 240000;
const staged = [], clients = [], samples = [], unavailable = [];
const driver = new McpDriver(config);

class TraceClient {
  queue = []; lines = ""; request = 0;
  constructor(command) { this.command = command; }
  async connect() {
    this.transport = new StdioClientTransport({ command: this.command, args: ["mcp", "--direct", "--embedded"], stderr: "pipe", env: {
      WSL_INTEROP: config.interop,
      WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "CUA_DRIVER_MCP_ENVELOPES", "DO_NOT_TRACK"].filter(Boolean).join(":"),
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", CUA_DRIVER_MCP_ENVELOPES: "1", DO_NOT_TRACK: "1",
    } });
    this.transport.stderr.on("data", chunk => {
      try {
        this.lines += chunk.toString(); assert.ok(this.lines.length < 65536);
        let end;
        while ((end = this.lines.indexOf("\n")) >= 0) {
          const line = this.lines.slice(0, end); this.lines = this.lines.slice(end + 1);
          if (!line.startsWith("CUA_NATIVE_PROFILE ")) continue;
          const trace = JSON.parse(line.slice(19)); accountNativeTrace(trace);
          if (this.wait) { const wait = this.wait; this.wait = undefined; wait.resolve(trace); }
          else { assert.ok(this.queue.length < 2); this.queue.push(trace); }
        }
      } catch (error) { this.failure = error; this.wait?.reject(error); }
    });
    this.client = new Client({ name: "pi-window-capture-qualification", version: "0.0.0" });
    await this.client.connect(this.transport, { signal: abort.signal, timeout: 15000 });
    assert.deepEqual(this.client.getServerVersion(), { name: "cua-driver", version: "0.34.0" });
    assert.equal(this.client.getServerCapabilities()?.experimental?.["ai.cua.driver.envelopes"]?.version, 1);
  }
  async observe(args) {
    assert.ok(!abort.signal.aborted && performance.now() < deadline);
    if (this.failure) throw this.failure;
    const start = performance.now();
    const result = CallToolResultSchema.parse(await this.client.callTool({ name: "get_window_state", arguments: args }, undefined, { signal: abort.signal, timeout: 15000 }));
    const rpc_ms = performance.now() - start;
    let trace;
    if (this.queue.length) trace = this.queue.shift();
    else {
      let timer;
      try { trace = await new Promise((resolve, reject) => { this.wait = { resolve, reject }; timer = setTimeout(() => reject(Error("Missing trace; no request replay")), 2000); }); }
      finally { clearTimeout(timer); this.wait = undefined; }
    }
    assert.equal(trace.request, ++this.request);
    return { result, rpc_ms, trace, accounting: accountNativeTrace(trace) };
  }
  async close() { try { await this.client?.close(); } finally { await this.transport?.close(); } }
}

async function prepare(role) {
  const entry = plan.variants[role], artifact = path.resolve(entry.directory);
  assert.match(entry.source, /^[a-f0-9]{40}$/); assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.ok(artifact.startsWith(path.resolve(".tmp/window-capture-latency") + path.sep));
  assert.equal((await readFile(path.join(artifact, "source-sha.txt"), "utf8")).trim(), entry.source);
  const hashes = JSON.parse(await readFile(path.join(artifact, "hashes.json"), "utf8"));
  assert.deepEqual(hashes.map(row => row.name).sort(), ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"].sort());
  for (const row of hashes) {
    const actual = hash(await readFile(path.join(artifact, "runtime", row.name)));
    assert.equal(actual, row.Hash.toLowerCase());
    if (row.name === "cua-driver.exe") assert.equal(actual, entry.sha256);
  }
  const target = path.join(path.dirname(config.command), ".tmp", "lpt-673", `${role}-${Date.now()}`);
  await cp(path.join(artifact, "runtime"), target, { recursive: true, force: false, errorOnExist: true }); staged.push(target);
  const client = new TraceClient(path.join(target, "cua-driver.exe")); clients.push(client); await client.connect(); return client;
}
const median = rows => { const s = [...rows].sort((a,b) => a-b); return s.length ? (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2 : null; };
let site, fixture, complete = false, cleanup;
try {
  const variants = {};
  for (const role of roles) variants[role] = await prepare(role);
  site = await createWindowCaptureSite();
  const root = path.dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
  fixture = await openCompleteInputWindow(driver, site.url, root);
  const observe = async (role, mode, phase) => {
    const args = { ...fixture.target, include_accessibility_tree: mode !== "image", include_screenshot: mode !== "ui", max_image_dimension: 500 };
    const row = await variants[role].observe(args);
    const { result, ...timing } = row;
    const state = result.structuredContent;
    assert.equal(timing.accounting.calls[role === "baseline" ? "metadata.process_snapshot" : "metadata.direct_process_name"], role === "baseline" && mode !== "ui" ? 2 : 1);
    if (role !== "baseline") assert.equal(timing.accounting.calls["metadata.process_snapshot"] ?? 0, 0);
    if (result.isError || state?.screenshot_error || (mode !== "ui" && !result.content.some(c => c.type === "image"))) {
      assert.ok(role === "wgc" || role === "wgcPoll5", "Required default-route capture failed");
      unavailable.push({ role, mode, phase, rpc_ms: timing.rpc_ms, trace: timing.trace }); return false;
    }
    assert.equal(Array.isArray(state?.elements), mode !== "image");
    const images = result.content.filter(c => c.type === "image"); assert.equal(images.length, mode === "ui" ? 0 : 1);
    const sample = { role, mode, phase, ...timing };
    if (images.length) {
      assert.equal(images[0].mimeType, "image/png");
      const bytes = Buffer.from(images[0].data, "base64");
      const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      sample.dimensions = { width: decoded.info.width, height: decoded.info.height };
      sample.png_bytes = bytes.length; assert.ok(Math.max(decoded.info.width, decoded.info.height) <= 500);
      const expected = site.state(); let colored = 0;
      for (let p = 0; p < decoded.data.length; p += 3) {
        if (expected.color.every((v,i) => Math.abs(decoded.data[p+i]-v) <= 3)) colored++;
      }
      sample.witness = { revision: expected.revision, acknowledged: expected.acknowledged, matching_pixels: colored };
      assert.ok(colored >= 40, "Capture did not contain the independently acknowledged current color");
      assert.equal(timing.accounting.calls["image.final_PNG_encode"], 1);
      if (role.startsWith("wgc")) assert.equal(timing.accounting.calls["wgc.total"], 1);
      if (phase === "setup") await writeFile(path.join(directory, `${role}-overview.png`), bytes);
    }
    samples.push(sample); return true;
  };
  const nextFrame = async () => {
    site.advance(); const until = performance.now() + 5000;
    while (!site.state().acknowledged) {
      assert.ok(!abort.signal.aborted && performance.now() < until && performance.now() < deadline, "Fixture did not acknowledge new drawing");
      await delay(25, undefined, { signal: abort.signal });
    }
  };
  await nextFrame();
  const enabled = [];
  for (const role of roles) if (await observe(role, "image", "setup")) enabled.push(role);
  for (let i = 0; i < 10; i++) {
    await nextFrame();
    for (const role of i % 2 ? [...enabled].reverse() : enabled) await observe(role, "image", "warm");
  }
  for (const mode of ["full", "ui"]) {
    for (const role of ["baseline", "direct"]) await observe(role, mode, "setup");
    for (let i = 0; i < 5; i++) for (const role of i % 2 ? ["direct", "baseline"] : ["baseline", "direct"]) await observe(role, mode, "warm");
  }
  assert.equal(site.events().length, 0, "All timing variants are read-only");
  complete = true;
} catch (error) {
  await writeFile(path.join(directory, "private-failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
  console.error("Window capture experiment stopped; no input or request replay.");
} finally {
  cleanup = await finishProfile(complete, {
    fixture: async () => { if (!fixture) return; const result = await fixture.close(); assert.ok(result.sourceGone && result.profileRemoved); },
    clients: async () => { for (const client of clients) await client.close(); await driver.close(); },
    site: async () => { await site?.close(); },
    candidate_files: async () => { for (const entry of staged) await rm(entry, { recursive: true, force: true }); },
  });
  assert.deepEqual(await readFile(configFile), configBytes); assert.equal(hash(await readFile(config.command)), installedHash);
  const summary = roles.map(role => ({ role, ...Object.fromEntries(["image", "full", "ui"].map(mode => {
    const rows = samples.filter(s => s.role === role && s.mode === mode && s.phase === "warm");
    return [mode, { count: rows.length, rpc_median_ms: median(rows.map(s => s.rpc_ms)), native_median_ms: median(rows.map(s => s.trace.total_us / 1000)) }];
  })) }));
  const report = { schema: 1, success: cleanup.success, plan, boundary: "Sequential SDK receipt; JS draw acknowledgements are not compositor timestamps", no_timing_input: true, config_unchanged: true, samples, unavailable, summary, cleanup: cleanup.cleanup };
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ success: report.success, summary, unavailable: unavailable.map(row => row.role), cleanup: cleanup.cleanup, report: path.join(directory, "report.json") }));
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  if (!report.success) process.exitCode = 1;
}
