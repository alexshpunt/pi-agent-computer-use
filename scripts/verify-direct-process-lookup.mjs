import assert from "node:assert/strict";
import path from "node:path";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// Supporting metadata/refusal check only. Never select these bytes as the installed runtime.
assert.ok(process.argv.includes("--owned-fixture"), "Authorize one disposable fixture explicitly.");
const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
const configFile = path.resolve(plan.config);
const configBytes = await readFile(configFile);
const config = { ...await loadComputerConfig(path.dirname(path.dirname(configFile))), interop: plan.interop };
assert.equal(config.runtime, "windows-fast-bilinear");
assert.match(config.interop, /^\/run\/WSL\/\d+_interop$/);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(await readFile(config.command)), plan.installed_sha256);
const artifact = path.resolve(plan.candidate.directory);
assert.ok(artifact.startsWith(path.resolve(".tmp/window-capture-latency") + path.sep));
assert.match(plan.candidate.source, /^[a-f0-9]{40}$/);
assert.equal((await readFile(path.join(artifact, "source-sha.txt"), "utf8")).trim(), plan.candidate.source);
const hashes = JSON.parse(await readFile(path.join(artifact, "hashes.json"), "utf8"));
assert.deepEqual(hashes.map(row => row.name).sort(), ["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"].sort());
for (const row of hashes) {
  const actual = hash(await readFile(path.join(artifact, "runtime", row.name)));
  assert.equal(actual, row.Hash.toLowerCase());
  if (row.name === "cua-driver.exe") assert.equal(actual, plan.candidate.sha256);
}
const directory = path.resolve(`.tmp/window-capture-latency/lookup-${Date.now()}`);
const staged = path.join(path.dirname(config.command), ".tmp", "lpt-673", `lookup-${Date.now()}`);
await mkdir(directory, { recursive: true });
const abort = new AbortController();
const interrupt = () => abort.abort();
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const deadline = performance.now() + 90000;
const driver = new McpDriver(config);
let transport, client, site, fixture, fixtureClosed = false, complete = false, calls = 0;
const checks = [];
async function candidateCall(args) {
  assert.ok(!abort.signal.aborted && performance.now() < deadline && ++calls <= 16, "Lookup verification budget exhausted");
  return CallToolResultSchema.parse(await client.callTool({ name: "get_window_state", arguments: args }, undefined, { signal: abort.signal, timeout: 15000 }));
}
function metadata(result, mode) {
  assert.ok(!result.isError, "Known owned window must remain observable");
  const state = result.structuredContent;
  assert.equal(state?.app_name?.toLowerCase(), "chrome.exe");
  assert.equal(state?.capture_coverage?.browser_chrome?.status, "not_observable_in_window_scope");
  assert.equal(Array.isArray(state.elements), mode !== "image");
  assert.equal(result.content.filter(c => c.type === "image").length, mode === "ui" ? 0 : 1);
  return { app_name: state.app_name, capture_coverage: state.capture_coverage };
}
function refusal(result, message) {
  assert.equal(result.isError, true, "Invalid ownership/lifetime must refuse");
  assert.equal(result.content.some(c => c.type === "image"), false, "Refusal must not capture another window");
  assert.equal(result.structuredContent?.app_name, undefined);
  assert.ok(result.content.some(c => c.type === "text" && c.text.includes(message)), "Expected native refusal reason");
}
try {
  await cp(path.join(artifact, "runtime"), staged, { recursive: true, force: false, errorOnExist: true });
  transport = new StdioClientTransport({ command: path.join(staged, "cua-driver.exe"), args: ["mcp", "--direct", "--embedded"], stderr: "ignore", env: {
    WSL_INTEROP: config.interop,
    WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "CUA_DRIVER_MCP_ENVELOPES", "DO_NOT_TRACK"].filter(Boolean).join(":"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", CUA_DRIVER_MCP_ENVELOPES: "1", DO_NOT_TRACK: "1",
  } });
  client = new Client({ name: "pi-direct-lookup-verification", version: "0.0.0" });
  await client.connect(transport, { signal: abort.signal, timeout: 15000 });
  assert.deepEqual(client.getServerVersion(), { name: "cua-driver", version: "0.34.0" });
  assert.equal(client.getServerCapabilities()?.experimental?.["ai.cua.driver.envelopes"]?.version, 1);
  site = await createWindowCaptureSite();
  const root = path.dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
  fixture = await openCompleteInputWindow(driver, site.url, root, ["--force-color-profile=srgb"]);
  site.advance();
  const acknowledgedBy = performance.now() + 5000;
  while (!site.state().acknowledged) {
    assert.ok(performance.now() < acknowledgedBy && !abort.signal.aborted, "Fixture acknowledgement timeout");
    await delay(25, undefined, { signal: abort.signal });
  }
  for (const mode of ["image", "ui", "full"]) {
    const args = { ...fixture.target, include_accessibility_tree: mode !== "image", include_screenshot: mode !== "ui", max_image_dimension: 500 };
    const before = await driver.call("get_window_state", args);
    const view = await candidateCall(args);
    assert.deepEqual(metadata(view, mode), metadata(before, mode));
    if (mode === "image") {
      const image = view.content.find(c => c.type === "image");
      const bytes = Buffer.from(image.data, "base64");
      const decoded = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const expected = site.state().color;
      let matching = 0;
      for (let p = 0; p < decoded.data.length; p += 3) if (expected.every((v,i) => Math.abs(decoded.data[p+i]-v) <= 3)) matching++;
      assert.ok(matching >= 40);
      await writeFile(path.join(directory, "owned-overview.png"), bytes);
    }
    checks.push({ check: "baseline_metadata_equal", mode, passed: true });
    refusal(await candidateCall({ ...args, pid: 0 }), "belongs to pid");
    checks.push({ check: "wrong_pid_refused_without_pixels_or_name", mode, passed: true });
    metadata(await candidateCall(args), mode);
    checks.push({ check: "valid_target_survives_refusal", mode, passed: true });
  }
  assert.equal(site.events().length, 0, "Verification sends no game or fixture-content input");
  const closed = await fixture.close();
  assert.ok(closed.sourceGone && closed.profileRemoved); fixtureClosed = true;
  for (const mode of ["image", "ui"]) {
    refusal(await candidateCall({ ...fixture.target, include_accessibility_tree: mode !== "image", include_screenshot: mode !== "ui", max_image_dimension: 500 }), "No window with window_id");
    checks.push({ check: "closed_owned_window_refused_without_pixels_or_name", mode, passed: true });
  }
  complete = true;
} catch (error) {
  await writeFile(path.join(directory, "private-failure.txt"), error instanceof Error ? error.stack ?? error.message : String(error));
  console.error("Direct lookup verification stopped; no input or request replay.");
} finally {
  const cleanup = await finishProfile(complete, {
    fixture: async () => { if (fixture && !fixtureClosed) { const result = await fixture.close(); assert.ok(result.sourceGone && result.profileRemoved); } },
    clients: async () => { await client?.close(); await transport?.close(); await driver.close(); },
    site: async () => { await site?.close(); },
    candidate_files: async () => { await rm(staged, { recursive: true, force: true }); },
  });
  assert.deepEqual(await readFile(configFile), configBytes);
  assert.equal(hash(await readFile(config.command)), plan.installed_sha256);
  const report = { schema: 1, success: cleanup.success, candidate: { source: plan.candidate.source, sha256: plan.candidate.sha256 }, checks, native_requests: calls, installed_unchanged: true, no_fixture_content_input: true, cleanup: cleanup.cleanup };
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, report: path.join(directory, "report.json") }));
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  if (!report.success) process.exitCode = 1;
}
