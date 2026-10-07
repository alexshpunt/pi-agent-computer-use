import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { finishProfile } from "../src/browser-profile.ts";
import { createUiResourcesSite } from "../test/fixtures/ui-resources-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { accountNativeTrace, summarizeNativeSamples } from "./native-observe-accounting.ts";

// Explicit timing-only runner. The diagnostic EXE is never selected by the production adapter.
const SOURCE = "6108128403821b6382418c131c3df8654aa35abe";
const BASE = "506239da08cfdafa63dac1857f5471752fb70f5e";
const HASH = "1e56928969c22a4eb7281772590b9b6946e43001654deb792e1388a2447610df";
const args = process.argv.slice(2);
assert.ok(args.length === 2 && /^[1-9]\d*$/.test(args[1]), "Usage: <downloaded artifact directory> <1..20 pairs per mode>");
const repeats = Number(args[1]); assert.ok(repeats <= 20);
const artifact = path.resolve(args[0]);
assert.ok(artifact.startsWith(path.resolve(".tmp/native-observe-profile") + path.sep));
assert.equal((await readFile(path.join(artifact, "source-sha.txt"), "utf8")).trim(), SOURCE);
const hashes = JSON.parse(await readFile(path.join(artifact, "hashes.json"), "utf8"));
assert.equal(hashes.length, 3);
for (const entry of hashes) {
  assert.ok(["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"].includes(entry.name));
  const hash = createHash("sha256").update(await readFile(path.join(artifact, "runtime", entry.name))).digest("hex");
  assert.equal(hash, entry.Hash.toLowerCase());
  if (entry.name === "cua-driver.exe") assert.equal(hash, HASH);
}
const configBytes = await readFile(".pi/computer-use.json");
const config = await loadComputerConfig(process.cwd());
assert.equal(config.runtime, "windows-shell-desktops");
assert.ok(config.command.startsWith("/mnt/c/"));
const installedHash = createHash("sha256").update(await readFile(config.command)).digest("hex");
assert.equal(installedHash, "0e25c8b83fd48b54be479eb128452a6f6b099b5ff6ce2d20bac024eda07ead16");
const directory = `.tmp/native-observe-profile/trace-${Date.now()}`;
await mkdir(directory, { recursive: true });
const staging = path.join(path.dirname(config.command), ".tmp", "lpt-649", `${SOURCE}-${Date.now()}`);
await cp(path.join(artifact, "runtime"), staging, { recursive: true, errorOnExist: true, force: false });
const abort = new AbortController();
const interrupt = () => abort.abort(); process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);

// Measure public SDK parsing and send boundaries without replacing its protocol.
class TimedTransport extends StdioClientTransport {
  metrics;
  processReadBuffer() {
    const start = performance.now();
    try { super.processReadBuffer(); }
    finally { if (this.metrics) this.metrics.parse_and_callback_ms += performance.now()-start; }
  }
  async send(message) {
    const start = performance.now();
    await super.send(message);
    if (this.metrics) this.metrics.send_ms += performance.now()-start;
  }
}
class DiagnosticClient {
  client; transport; lines = ""; reports = []; waiter; request = 0; failure;
  async connect() {
    this.transport = new TimedTransport({ command: path.join(staging, "cua-driver.exe"), args: ["mcp", "--direct", "--embedded"], stderr: "pipe", env: {
      WSL_INTEROP: config.interop ?? process.env.WSL_INTEROP,
      WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "CUA_DRIVER_MCP_ENVELOPES", "DO_NOT_TRACK"].filter(Boolean).join(":"),
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", CUA_DRIVER_MCP_ENVELOPES: "1", DO_NOT_TRACK: "1",
    } });
    this.transport.stderr.on("data", chunk => {
      try {
        this.lines += chunk.toString(); assert.ok(this.lines.length <= 65536, "Unbounded native diagnostic line.");
        let index;
        while ((index = this.lines.indexOf("\n")) >= 0) {
          const line = this.lines.slice(0,index).trim(); this.lines = this.lines.slice(index+1);
          if (!line.startsWith("CUA_NATIVE_PROFILE ")) continue;
          const trace = JSON.parse(line.slice("CUA_NATIVE_PROFILE ".length));
          accountNativeTrace(trace);
          const report = { trace, received: performance.now() };
          if (this.waiter) { const waiter=this.waiter; this.waiter=undefined; waiter.resolve(report); }
          else { assert.ok(this.reports.length < 2); this.reports.push(report); }
        }
      } catch (error) { this.failure=error; this.waiter?.reject(error); }
    });
    this.client = new Client({ name: "pi-native-observe-diagnostic", version: "0.0.0" });
    await this.client.connect(this.transport, { signal: abort.signal, timeout: 15000 });
    assert.deepEqual(this.client.getServerVersion(), { name: "cua-driver", version: "0.34.0" });
    assert.equal(this.client.getServerCapabilities()?.experimental?.["ai.cua.driver.envelopes"]?.version, 1);
  }
  async observe(options) {
    assert.ok(!abort.signal.aborted); if (this.failure) throw this.failure;
    const metrics = { send_ms: 0, parse_and_callback_ms: 0, parsed_receipt_ms: null };
    const callback = this.transport.onmessage;
    this.transport.onmessage = message => { if (Object.hasOwn(message, "result") || Object.hasOwn(message,"error")) metrics.parsed_receipt_ms=performance.now(); callback(message); };
    this.transport.metrics=metrics;
    const start=performance.now();
    let result, rpcEnd, projection_ms;
    try {
      const raw = await this.client.callTool({ name: "get_window_state", arguments: options }, undefined, { signal: abort.signal, timeout: 15000 });
      rpcEnd=performance.now();
      result=CallToolResultSchema.parse(raw); projection_ms=performance.now()-rpcEnd;
    } finally { this.transport.metrics=undefined; this.transport.onmessage=callback; }
    const report=await this.nextReport();
    assert.equal(report.trace.request, ++this.request, "Native request ordinal must match the one sequential SDK call.");
    return { result, timing: { rpc_ms: rpcEnd-start, projection_ms, send_ms: metrics.send_ms,
      parse_and_callback_ms: metrics.parse_and_callback_ms,
      parsed_to_rpc_resolve_ms: metrics.parsed_receipt_ms === null ? null : rpcEnd-metrics.parsed_receipt_ms,
      report_after_rpc_ms: report.received-rpcEnd, trace: report.trace, accounting: accountNativeTrace(report.trace) } };
  }
  async nextReport() {
    if (this.failure) throw this.failure;
    if (this.reports.length) return this.reports.shift();
    let timer;
    try { return await new Promise((resolve,reject) => { this.waiter={resolve,reject}; timer=setTimeout(()=>reject(Error("Native trace missing; stop, do not repeat.")),2000); }); }
    finally { clearTimeout(timer); this.waiter=undefined; }
  }
  async close() { try { await this.client?.close(); } finally { await this.transport?.close(); } }
}
const installed=new McpDriver(config), diagnostic=new DiagnosticClient();
const samples=[];
let fixture, site, completed=false, cleanup;
const modes=["image_500", "image_native", "ui_only", "full_500"];
try {
  site=await createUiResourcesSite();
  const root=path.dirname(config.command).replace("/mnt/c/","C:\\").replaceAll("/","\\");
  fixture=await openCompleteInputWindow(installed,site.url,root);
  await diagnostic.connect();
  const measurementStart=performance.now();
  const observe=async(runtime, mode, phase) => {
    assert.ok(!abort.signal.aborted);
    assert.ok(performance.now()-measurementStart < 180000, "Three-minute measurement budget exhausted; stop without replay.");
    const options={...fixture.target, include_accessibility_tree: mode==="ui_only" || mode==="full_500", include_screenshot: mode!=="ui_only", max_image_dimension: mode==="image_native" ? 0 : 500};
    let result, timing;
    if (runtime==="diagnostic") ({result,timing}=await diagnostic.observe(options));
    else { const start=performance.now(); result=await installed.call("get_window_state",options,abort.signal); timing={rpc_ms:performance.now()-start}; }
    assert.ok(!result.isError && !result.structuredContent?.screenshot_error, "Owned native capture failed.");
    const images=result.content.filter(c=>c.type==="image");
    assert.equal(images.length, mode==="ui_only" ? 0 : 1);
    assert.equal(Array.isArray(result.structuredContent?.elements),options.include_accessibility_tree);
    const sample={runtime,mode,phase,...timing,verified:true};
    if(images.length) {
      const png=Buffer.from(images[0].data,"base64"); assert.equal(png.subarray(1,4).toString(),"PNG");
      sample.dimensions={width:png.readUInt32BE(16),height:png.readUInt32BE(20)}; sample.png_bytes=png.length;
      if(mode!=="image_native") assert.equal(Math.max(...Object.values(sample.dimensions)),500);
      if(runtime==="diagnostic" && phase==="setup" && mode==="full_500") await writeFile(`${directory}/owned-overview.png`,png);
    }
    samples.push(sample);
  };
  for(const mode of modes) for(const runtime of ["installed","diagnostic"]) await observe(runtime,mode,"setup");
  for(let i=0;i<repeats;i++) for(let n=0;n<modes.length;n++) {
    const mode=modes[(i+n)%modes.length];
    for(const runtime of i%2 ? ["diagnostic","installed"] : ["installed","diagnostic"]) await observe(runtime,mode,"warm");
  }
  assert.equal(site.events().length,0,"Measured probes must send no app input.");
  for(const mode of modes) {
    const dimensions=samples.filter(s=>s.mode===mode && s.dimensions).map(s=>JSON.stringify(s.dimensions));
    assert.equal(new Set(dimensions).size, mode==="ui_only" ? 0 : 1,"Paired geometry must match.");
  }
  completed=true;
} catch(error) { await writeFile(`${directory}/private-failure.txt`,String(error)); console.error("Native trace stopped; no request replay."); }
finally {
  cleanup=await finishProfile(completed,{
    fixture:async()=>{assert.ok(fixture);const c=await fixture.close();assert.ok(c.sourceGone&&c.profileRemoved);},
    diagnostic:()=>diagnostic.close(), installed:()=>installed.close(), site:async()=>{await site?.close();},
    diagnostic_files:()=>rm(staging,{recursive:true,force:true}),
  });
  assert.deepEqual(await readFile(".pi/computer-use.json"),configBytes,"Installed config changed during the measurement.");
  assert.equal(createHash("sha256").update(await readFile(config.command)).digest("hex"),installedHash);
  const report={schema:1,success:cleanup.success,source:SOURCE,base:BASE,build_run:37677013717,diagnostic_exe_sha256:HASH,installed_exe_sha256:installedHash,
    boundary:"SDK call receipt; native parse/admit through stdout flush; stderr reporting outside native interval",
    input_events_during_samples:site?.events().length??null,installed_config_unchanged:true,cleanup:cleanup.cleanup,samples,summary:summarizeNativeSamples(samples)};
  await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2)+"\n");
  const concise=report.summary.map(s=>({mode:s.mode,count:s.count,installed_mean_ms:s.installed.mean_ms,diagnostic_mean_ms:s.diagnostic.mean_ms,native_mean_ms:s.diagnostic.native_mean_ms,
    largest:s.diagnostic.stages && Object.entries(s.diagnostic.stages).sort((a,b)=>b[1]-a[1]).slice(0,6)}));
  console.log(JSON.stringify({success:report.success,cleanup:report.cleanup,summary:concise,report:`${directory}/report.json`}));
  process.off("SIGINT",interrupt);process.off("SIGTERM",interrupt);
  if(!report.success)process.exitCode=1;
}
