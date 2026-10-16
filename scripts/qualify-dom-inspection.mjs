import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDomInspectionPages } from "./fixtures/dom-inspection-pages.mjs";
import { nativeWindowState } from "./native-window-state.mjs";
import { assertBridgeDispatchAllowed, assertSelectedBridgeTab } from "./owned-browser-bridge-contract.mjs";
import { closePixelProbeServer } from "./dom-native-pixel-contract.mjs";
import { validateDomSnapshot } from "../src/dom-inspection.ts";
import { assertCssomWitness } from "./dom-cssom-contract.mjs";

// Standalone native qualification, not an ordinary IDE provider or a crop implementation.
// Usage: node --experimental-transform-types scripts/qualify-dom-inspection.mjs --live-approved
const geometryOnly = process.argv.includes("--cssom-geometry");
assert.deepEqual(process.argv.slice(2), geometryOnly ? ["--live-approved", "--cssom-geometry"] : ["--live-approved"]);
const command = process.env.CUA_DRIVER_PATH, expected = process.env.CUA_DRIVER_SHA256;
assert.ok(command?.endsWith(".exe")); assert.match(expected ?? "", /^[a-f0-9]{64}$/);
assert.ok(process.env.WSL_INTEROP && (await stat(process.env.WSL_INTEROP)).isSocket());
const hash = createHash("sha256").update(await readFile(command)).digest("hex");
assert.equal(hash, expected, "Use the exact independently verified candidate.");
const directory = `.tmp/lpt-733/dom-${Date.now()}`, nonce = randomUUID();
const session = `pi-dom-inspection-${randomUUID()}`, title = `Pi DOM inspection ${nonce} root`;
const transitionAfterMs = geometryOnly ? 0 : 90_000, records = [], checks = [], limitations = [];
await mkdir(directory, { recursive: true });
let fixture, target, page, profile, url, crossOrigin, started = false, stopping = false, navigated = false, stderr = "";
const servers = [createServer(), createServer()];
for (const server of servers) server.on("request", (request, response) => {
  if (!fixture) { response.writeHead(503).end(); return; }
  void fixture.handle(request, response).catch(error => { response.destroy(error); });
});
const transport = new StdioClientTransport({ command, args: ["mcp", "--direct", "--embedded"], stderr: "pipe", env: {
  WSL_INTEROP: process.env.WSL_INTEROP,
  WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"].filter(Boolean).join(":"),
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", DO_NOT_TRACK: "1",
} });
transport.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
const client = new Client({ name: "pi-readonly-dom-qualification", version: "0.0.0" });
const save = () => writeFile(`${directory}/run.json`, JSON.stringify({ hash, session, nonce, url, crossOrigin, transitionAfterMs,
  target, page, profile, records, checks, limitations, witness_status: fixture?.status(), reports: fixture?.reports() }, null, 2) + "\n");
const stop = () => { stopping = true; process.exitCode = 1; };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const lifetime = setTimeout(stop, 210_000);

async function call(label, name, args = {}, expectedRefusal) {
  assertBridgeDispatchAllowed(stopping, name);
  assert.ok(records.length < 128 || name === "end_session", "Bounded native-call journal exhausted.");
  assert.ok(["start_session", "end_session", "browser_prepare", "list_windows", "get_browser_state", "browser_navigate"].includes(name));
  if (name === "browser_navigate") {
    assert.equal(args.url, url, "Navigate only to the owned root fixture.");
    assert.equal(navigated, false, "No replacement browser/page or navigation replay.");
    navigated = true;
  }
  const start = performance.now();
  let result;
  try { result = await client.callTool({ name, arguments: { ...args, session } }, undefined, { timeout: 30_000 }); }
  catch (error) {
    records.push({ label, name, args, elapsed_ms: performance.now() - start, error: String(error), outcome: "unknown; no replay" });
    await save(); throw error;
  }
  const record = { label, name, args, elapsed_ms: performance.now() - start, isError: result.isError ?? false,
    structuredContent: result.structuredContent,
    text: (result.content ?? []).filter(block => block.type === "text").map(block => block.text) };
  records.push(record); await save(); console.log(JSON.stringify({ directory, ...record }));
  assert.ok(!(result.content ?? []).some(block => block.type === "image"), "DOM-only qualification must not silently acquire page/native pixels.");
  if (expectedRefusal) {
    assert.equal(result.structuredContent?.status, "refused", "Expected a known no-input refusal, not an interrupted/unknown outcome.");
    assert.equal(result.structuredContent.refusal?.code, expectedRefusal);
  } else {
    assert.ok(!result.isError && result.structuredContent?.status !== "refused" && !result.structuredContent?.refusal && !result.structuredContent?.error && !["refused", "unknown"].includes(result.structuredContent?.effect),
      "Unknown or refused native outcomes stop this probe without fallback/replay.");
  }
  return result.structuredContent;
}
async function selected(label) {
  const bound = await call(label, "get_browser_state", target);
  assertSelectedBridgeTab(bound, url, title);
}
function latestReports() {
  const reports = fixture.reports(), latest = new Map();
  assert.ok(reports.length > 0 && reports.length <= 2048);
  assert.equal(fixture.status().rejected, 0, "Rejected reports are not clean acceptance.");
  const identities = new Map();
  for (const report of reports) {
    assert.deepEqual(report.events, [], "Every retained journal must remain empty, not just the latest one.");
    assert.equal(report.eventOverflow, false);
    const previous = identities.get(report.page);
    assert.ok(!previous || previous === report.pageNonce, "A same-URL document replacement cannot erase input evidence.");
    identities.set(report.page, report.pageNonce); latest.set(report.page, report);
  }
  return latest;
}
async function witness(label, rootStage) {
  const required = ["root", "frame", "nested", "cross"];
  let latest;
  for (let i = 0; i < 50; i++) {
    assertBridgeDispatchAllowed(stopping, "witness");
    latest = fixture.reports().length ? latestReports() : new Map();
    if (required.every(kind => latest.has(kind) && Date.now() - latest.get(kind).received_ms >= 0 && Date.now() - latest.get(kind).received_ms <= 5000)
      && (rootStage === undefined || latest.get("root").stage === rootStage)) break;
    await delay(100);
  }
  for (const kind of required) {
    const report = latest.get(kind);
    assert.ok(report && Date.now() - report.received_ms >= 0 && Date.now() - report.received_ms <= 5000, `Missing/stale ${kind} witness.`);
  }
  if (rootStage !== undefined) assert.equal(latest.get("root").stage, rootStage, "Timer stage was not independently witnessed.");
  const native = await nativeWindowState(process.env.WSL_INTEROP, [target]);
  assert.equal(native.status, "measured"); assert.equal(native.windows[0].exists, true);
  assert.equal(native.windows[0].owner_pid, target.pid);
  const record = { label, reports: Object.fromEntries(latest), native };
  await writeFile(`${directory}/${label}.json`, JSON.stringify(record, null, 2) + "\n");
  await save(); console.log(JSON.stringify({ directory, witness: record })); return record;
}
async function inspect(label, options = {}) {
  await selected(`${label}-selected-before`);
  const maxNodes = options.max_nodes ?? 200;
  const raw = await call(label, "get_browser_state", { ...page, snapshot_format: "dom_inspect_v1", include_screenshot: false,
    include_hidden: true, max_nodes: maxNodes, max_depth: 32, ...options });
  const snapshot = validateDomSnapshot(raw, page, maxNodes);
  assert.equal(snapshot.page.url, url); assert.equal(snapshot.page.title, title);
  await selected(`${label}-selected-after`);
  checks.push({ label, snapshot: snapshot.id, complete: snapshot.complete, collection_complete: snapshot.collection_complete,
    returned_count: snapshot.returned_count, matched_count: snapshot.matched_count, omitted: snapshot.omitted });
  return snapshot;
}
function mainRows(snapshot) { return snapshot.elements.filter(row => row.frame.kind === "main"); }
function oneMain(snapshot, id) {
  const rows = mainRows(snapshot).filter(row => row.attributes.id === id);
  assert.equal(rows.length, 1, `Require the exact main-document ${id} record; no first-match or foreign-frame fallback.`);
  return rows[0];
}
function metadata(row, key, expectedValue, label) {
  const actual = row.states[key];
  if (actual === undefined || actual === null) limitations.push({ label, unavailable_state: key });
  else {
    // CDP AX tristates can preserve the exact strings "true"/"false"; "mixed" is not true.
    const measured = actual === "true" ? true : actual === "false" ? false : actual;
    assert.equal(measured, expectedValue, `${label} contradicted the independent fixture.`);
  }
}
async function qualifyCssom(before) {
  const field = oneMain(await inspect("cssom-current-field", { locator: { test_id: "value" } }), "value");
  async function sample(label, row, nodeId) {
    await selected(`${label}-selected-before`);
    const measured = await call(label, "get_browser_state", { ...page, snapshot_format: "dom_inspect_v1", geometry_ref: row.ref });
    await selected(`${label}-selected-after`);
    const independent = await witness(`${label}-witness`, 0);
    assert.equal(independent.reports.root.pageNonce, before.reports.root.pageNonce);
    const proof = assertCssomWitness(measured, { page, reference: row.ref, report: independent.reports.root, nodeId });
    checks.push({ label, ...proof }); await save();
  }
  await sample("cssom-field-first", field, "value");
  // A repeated read must work with a fresh attachment to the same live source.
  await sample("cssom-field-repeat", field, "value");
  const shadow = oneMain(await inspect("cssom-current-shadow", { locator: { test_id: "shadow-choice" } }), "shadow-choice");
  await sample("cssom-open-shadow", shadow, "shadow-choice");
  await call("cssom-superseded-ref", "get_browser_state", { ...page, snapshot_format: "dom_inspect_v1", geometry_ref: field.ref }, "browser_ref_stale");
  const frames = await inspect("cssom-frame-sources", { locator: { css: "#duplicate-a" } });
  const children = frames.elements.filter(row => row.frame.kind !== "main");
  assert.ok(children.length > 0 && children.length <= 3, "Require the bounded fixture's contained child sources.");
  for (const row of children) {
    await call(`cssom-child-refusal-${row.frame.ref}`, "get_browser_state",
      { ...page, snapshot_format: "dom_inspect_v1", geometry_ref: row.ref }, "browser_route_unavailable");
  }
  const final = await witness("cssom-final", 0);
  assert.deepEqual(final.native.pointer, before.native.pointer);
  await selected("cssom-selected-final");
  await save();
  console.log(JSON.stringify({ directory, sampling_complete: true, cssom_fixture_samples_verified: true,
    qualification_scope: "Current synthetic main/open-shadow elements at the recorded viewport and scroll only",
    visual_viewport_independently_witnessed: false, native_pixel_mapping_qualified: false,
    ordinary_ide_acceptance: false, atomic_dom_native_paint: false }));
}
async function ownedProfile(pid) {
  const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if(!$p){throw 'Owned process gone'};$p.CommandLine`;
  const { stdout } = await promisify(execFile)("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 10_000, env: { ...process.env, WSL_INTEROP: process.env.WSL_INTEROP } });
  const match = stdout.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/); assert.ok(match);
  const windowsPath = match[1] ?? match[2];
  assert.match(windowsPath, /^[A-Za-z]:\\/);
  assert.match(windowsPath, /\\CuaDriver\\BrowserProfiles\\isolated-[a-f0-9-]+$/i);
  const local = `/mnt/${windowsPath[0].toLowerCase()}/${windowsPath.slice(3).replaceAll("\\", "/")}`;
  assert.ok((await stat(local)).isDirectory()); return { windowsPath, local };
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
}

try {
  await listen(servers[0]); await listen(servers[1]);
  url = `http://127.0.0.1:${servers[0].address().port}/`;
  crossOrigin = `http://127.0.0.1:${servers[1].address().port}`;
  fixture = createDomInspectionPages({ nonce, origin: new URL(url).origin, crossOrigin, transitionAfterMs, maxReports: 2048 });
  await client.connect(transport, { timeout: 15_000 }); assert.equal(client.getServerVersion()?.name, "cua-driver");
  const tools = await client.listTools(undefined, { timeout: 15_000 });
  await writeFile(`${directory}/tools-list.json`, JSON.stringify(tools, null, 2) + "\n");
  assert.ok(!tools.nextCursor, "Require complete native tool discovery before owned launch.");
  const stateSchema = tools.tools.find(tool => tool.name === "get_browser_state")?.inputSchema?.properties;
  assert.ok(stateSchema?.snapshot_format?.enum?.includes("dom_inspect_v1"), "Candidate must advertise the typed readonly DOM route.");
  for (const key of ["locator", "scope_ref", "include_hidden", "max_nodes", "max_depth"]) assert.ok(stateSchema[key], `Missing native DOM contract: ${key}`);
  if (geometryOnly) assert.ok(stateSchema.geometry_ref, "Explicit CSSOM mode requires the native geometry_ref contract before launch.");
  started = true; // An unknown start outcome still needs named-session cleanup.
  await call("start", "start_session");
  const prepared = await call("prepare", "browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } });
  assert.equal(prepared.prepared, true); assert.ok(Number.isSafeInteger(prepared.prepared_pid) && prepared.prepared_pid > 0);
  profile = await ownedProfile(prepared.prepared_pid);
  const windows = (await call("windows", "list_windows", { pid: prepared.prepared_pid })).windows;
  assert.equal(windows.length, 1); target = { pid: windows[0].pid, window_id: windows[0].window_id }; assert.equal(target.pid, prepared.prepared_pid);
  const bound = await call("bind", "get_browser_state", target);
  assert.equal(bound.binding_quality, "exact"); assert.equal(bound.tabs.length, 1); assert.equal(bound.tabs[0].active, true);
  page = { target_id: bound.target_id, tab_id: bound.tabs[0].tab_id };
  await call("fixture-navigation", "browser_navigate", { ...page, url });
  const before = await witness("baseline", 0);

  if (geometryOnly) {
    await qualifyCssom(before);
  } else {
  const css = await inspect("css-shadow-and-duplicates", { locator: { css: "button[aria-label='Duplicate choice']" } });
  assert.deepEqual(mainRows(css).map(row => row.attributes.id).sort(), ["duplicate-a", "duplicate-b", "shadow-choice"]);
  const frameGroups = new Map();
  for (const row of css.elements) {
    assert.equal(row.tag.toLowerCase(), "button");
    const group = frameGroups.get(row.frame.ref) ?? { kind: row.frame.kind, ids: [] };
    assert.equal(group.kind, row.frame.kind); group.ids.push(row.attributes.id); frameGroups.set(row.frame.ref, group);
  }
  for (const group of frameGroups.values()) assert.equal(new Set(group.ids).size, group.ids.length, "Colliding backend IDs cannot merge distinct documents.");
  checks.push({ label: "observed-frame-sources", frames: Object.fromEntries(frameGroups), independent_documents: ["root", "frame", "nested", "cross"] });
  if (frameGroups.size < 4) limitations.push({ label: "frames", observed_sources: frameGroups.size, expected_fixture_documents: 4, omitted: css.omitted });

  const exact = await inspect("exact-role-name", { locator: { role: "button", name: "Duplicate choice" } });
  assert.deepEqual(mainRows(exact).map(row => row.attributes.id).sort(), ["duplicate-a", "duplicate-b", "shadow-choice"]);
  const field = oneMain(await inspect("accessible-label", { locator: { label: "Accessible field label" } }), "value");
  if (field.value === null) limitations.push({ label: "field-live-value", unavailable: true });
  else assert.equal(field.value, "fixture value");
  assert.equal(field.attributes["data-testid"], "value"); assert.equal(field.attributes.title, "Field attribute");
  const rootField = before.reports.root.nodes.find(node => node.id === "value"); assert.ok(rootField);
  if (field.bounds_css === null) limitations.push({ label: "field-css-bounds", unavailable: true });
  else {
    const expected = { x: rootField.bounds.x + before.reports.root.viewport.scroll_x,
      y: rootField.bounds.y + before.reports.root.viewport.scroll_y, width: rootField.bounds.width, height: rootField.bounds.height };
    try { assert.deepEqual(field.bounds_css, expected); }
    catch { limitations.push({ label: "field-css-units-unqualified", native_declared_bounds_css: field.bounds_css, independent_css_bounds: expected,
      disposition: "No CSS/native transform or crop admitted; keep qualifying unrelated readonly metadata." }); }
  }
  oneMain(await inspect("substring-text", { locator: { text: "Original generation" } }), "replaceable");
  const hidden = oneMain(await inspect("hidden-testid", { locator: { test_id: "hidden" } }), "hidden");
  if (hidden.visibility === "unknown") limitations.push({ label: "hidden-visibility", unavailable: true });
  else assert.equal(hidden.visibility, "hidden");
  const filtered = await inspect("visible-only-filter", { locator: { test_id: "hidden" }, include_hidden: false });
  assert.equal(filtered.returned_count, 0, "Hidden records must not be returned as proven visible.");
  const disabled = oneMain(await inspect("disabled-state", { locator: { test_id: "disabled" } }), "disabled");
  metadata(disabled, "disabled", true, "disabled-state");
  const checked = oneMain(await inspect("checked-state", { locator: { css: "#checked" } }), "checked");
  metadata(checked, "checked", true, "checked-state");
  const selectedOption = mainRows(await inspect("selected-state", { locator: { css: "#selected option:checked" } }));
  assert.equal(selectedOption.length, 1); assert.equal(selectedOption[0].tag.toLowerCase(), "option");
  metadata(selectedOption[0], "selected", true, "selected-state");

  const scopeRows = mainRows(await inspect("scope-admission", { locator: { css: "section[aria-label='Duplicate label scope']" } }));
  assert.equal(scopeRows.length, 1, "Require one exact main-frame scope; do not choose a duplicate from another source.");
  const section = scopeRows[0];
  const scoped = await inspect("main-frame-scope", { scope_ref: section.ref, locator: { role: "button", name: "Duplicate choice" } });
  assert.equal(scoped.scope, "subtree"); assert.equal(scoped.elements.length, 2);
  assert.ok(scoped.elements.every(row => row.frame.kind === "main"));
  assert.equal(new Set(scoped.elements.map(row => row.frame.ref)).size, 1, "Scope cannot escape its current frame source.");
  // Frame refs are opaque per snapshot; do not assume the fresh frame token equals the preceding snapshot token.
  assert.deepEqual(scoped.elements.map(row => row.attributes.id).sort(), ["duplicate-a", "duplicate-b"]);
  const partial = await inspect("bounded-absence-is-unknown", { locator: { css: "#fixture-element-that-does-not-exist" }, max_nodes: 1, max_depth: 1 });
  assert.equal(partial.complete, false); assert.equal(partial.collection_complete, false);
  assert.ok(Object.values(partial.omitted).some(count => count > 0), "Partial traversal must report its omission.");
  checks.push({ label: "bounded-absence-interpretation", definitive_absence: false });

  await witness("before-timer-ref", 0);
  const detachable = oneMain(await inspect("detachable-current-ref", { locator: { test_id: "detachable" } }), "detachable");
  for (let i = 0; i < 440; i++) {
    assertBridgeDispatchAllowed(stopping, "timer-wait");
    const latest = latestReports(); if (latest.get("root")?.stage === 1) break;
    await delay(250);
  }
  const transitioned = await witness("timer-transition", 1); assert.equal(transitioned.reports.root.detached, true);
  await selected("stale-scope-selected-before");
  await call("detached-scope-refusal", "get_browser_state", { ...page, snapshot_format: "dom_inspect_v1", scope_ref: detachable.ref,
    include_screenshot: false, include_hidden: true, max_nodes: 200, max_depth: 32 }, "browser_ref_stale");
  await selected("stale-scope-selected-after");
  const replacement = oneMain(await inspect("fresh-replacement", { locator: { test_id: "replaceable" } }), "replaceable");
  assert.equal(replacement.attributes["data-generation"], "1"); assert.ok(replacement.text.includes("Replacement generation"));
  const after = await witness("final", 1); assert.deepEqual(after.native.pointer, before.native.pointer, "Physical pointer changed during readonly inspection.");
  await selected("selected-final");
  await save();
  console.log(JSON.stringify({ directory, sampling_complete: true, metadata_qualified: limitations.length === 0, limitations,
    ordinary_ide_acceptance: false, crop_qualified: false, atomic_dom_native_paint: false }));
  if (limitations.length) process.exitCode = 1;
  }
} finally {
  const cleanup = {};
  try { if (started) { await call("end", "end_session"); cleanup.sessionEnded = true; } }
  catch (error) { cleanup.end_error = String(error); process.exitCode = 1; }
  try {
    if (target && profile) {
      for (let i = 0; i < 3; i++) {
        cleanup.native = await nativeWindowState(process.env.WSL_INTEROP, [target]);
        cleanup.profileExists = await stat(profile.local).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
        if (cleanup.native.status === "measured" && !cleanup.native.windows[0].exists && !cleanup.profileExists) break;
        await delay(200);
      }
      assert.equal(cleanup.native.status, "measured"); assert.equal(cleanup.native.windows[0].exists, false); assert.equal(cleanup.profileExists, false);
    } else if (started) { cleanup.verification = "Exact owned source unavailable"; process.exitCode = 1; }
  } catch (error) { cleanup.verification_error = String(error); process.exitCode = 1; }
  const releases = await Promise.allSettled([
    (async () => { try { await client.close(); } finally { await transport.close(); } })(),
    ...servers.map(server => closePixelProbeServer(server)),
  ]);
  cleanup.release_errors = releases.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  if (cleanup.release_errors.length) process.exitCode = 1;
  try {
    if (fixture?.reports().length) { latestReports(); cleanup.witness_integrity = true; }
  } catch (error) { cleanup.witness_error = String(error); process.exitCode = 1; }
  clearTimeout(lifetime);
  await save(); await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2) + "\n");
  await writeFile(`${directory}/stderr.log`, stderr); console.log(JSON.stringify({ directory, cleanup }));
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
}
