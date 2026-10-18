import assert from "node:assert/strict";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { assertSelectedBridgeTab, assertBridgeDispatchAllowed } from "./owned-browser-bridge-contract.mjs";
import { closePixelProbeServer } from "./dom-native-pixel-contract.mjs";
import { VIEWPORT_MARKERS, createViewportProofPage, validateViewportReport, assertViewportHistory } from "./fixtures/dom-viewport-proof-page.mjs";

const rectKeys = ["x", "y", "width", "height"];
const finite = value => typeof value === "number" && Number.isFinite(value);
const checkRect = rect => assert.ok(rect && rectKeys.every(key => finite(rect[key])) && rect.width > 0 && rect.height > 0);
const equalRect = (left, right) => assert.ok(rectKeys.every(key => left[key] === right[key]), "Native enclosure differs from the predeclared rule.");

/** Verify only original WGC pixels against source/native geometry sampled before acquisition.
 * Integral boxes require every pixel; fractional boxes require the fully covered interior.
 * Boundary antialias colors are deliberately not invented. No offset/color search exists.
 */
export function verifyViewportRaster({ rgba, width, height, capture, nativeViewport, layout, scroll, samples }) {
  assert.ok(Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= 16_000_000);
  assert.ok(rgba instanceof Uint8Array && rgba.length === width * height * 4);
  assert.equal(capture?.capture_backend?.backend, "wgc");
  const frame = capture.capture_backend.frame_bounds;
  checkRect(frame); checkRect(nativeViewport);
  assert.ok(rectKeys.every(key => Number.isSafeInteger(frame[key]) && Number.isSafeInteger(nativeViewport[key])));
  for (const [key, value] of Object.entries({ screenshot_width: width, screenshot_height: height,
    screenshot_original_width: width, screenshot_original_height: height })) assert.equal(capture[key], value, "Scaled or inconsistent native pixels.");
  assert.equal(frame.width, width); assert.equal(frame.height, height);
  const dpr = layout?.dpr;
  assert.ok(finite(dpr) && dpr >= 0.25 && dpr <= 8 && finite(layout.width) && finite(layout.height));
  assert.equal(layout.width * dpr, nativeViewport.width, "No viewport-width tolerance or fitted ratio.");
  assert.equal(layout.height * dpr, nativeViewport.height, "No viewport-height tolerance or fitted ratio.");
  assert.ok(scroll?.x === 0 && [0, 100].includes(scroll?.y));
  assert.ok(Array.isArray(samples) && samples.length === VIEWPORT_MARKERS.length);
  assert.equal(new Set(samples.map(sample => sample.id)).size, VIEWPORT_MARKERS.length);
  const colorAt = (x, y) => {
    const offset = (y * width + x) * 4;
    return [rgba[offset], rgba[offset + 1], rgba[offset + 2], rgba[offset + 3]];
  };
  const results = [];
  for (const marker of VIEWPORT_MARKERS) {
    const sample = samples.find(sample => sample.id === marker.id); assert.ok(sample);
    const css = { x: marker.x - scroll.x, y: marker.y - scroll.y, width: marker.width, height: marker.height };
    equalRect(sample.css, css);
    const edges = { left: css.x * dpr, top: css.y * dpr, right: (css.x + css.width) * dpr, bottom: (css.y + css.height) * dpr };
    const native = { x: nativeViewport.x + Math.floor(edges.left), y: nativeViewport.y + Math.floor(edges.top),
      width: Math.ceil(edges.right) - Math.floor(edges.left), height: Math.ceil(edges.bottom) - Math.floor(edges.top) };
    equalRect(sample.screen, native);
    assert.ok(native.x >= nativeViewport.x && native.y >= nativeViewport.y &&
      native.x + native.width <= nativeViewport.x + nativeViewport.width && native.y + native.height <= nativeViewport.y + nativeViewport.height);
    const pixels = { x: native.x - frame.x, y: native.y - frame.y, width: native.width, height: native.height };
    assert.ok(pixels.x >= 1 && pixels.y >= 1 && pixels.x + pixels.width < width && pixels.y + pixels.height < height);
    const integral = Object.values(edges).every(Number.isInteger);
    const interior = integral ? pixels : { x: nativeViewport.x + Math.ceil(edges.left) - frame.x,
      y: nativeViewport.y + Math.ceil(edges.top) - frame.y,
      width: Math.floor(edges.right) - Math.ceil(edges.left), height: Math.floor(edges.bottom) - Math.ceil(edges.top) };
    assert.ok(interior.width > 0 && interior.height > 0);
    const expected = [marker.rgb, marker.rgb, marker.rgb, 255];
    for (let y = interior.y; y < interior.y + interior.height; y++)
      for (let x = interior.x; x < interior.x + interior.width; x++)
        assert.deepEqual(colorAt(x, y), expected, `${marker.id}: mismatched declared interior at ${x},${y}`);
    for (let y = pixels.y - 1; y <= pixels.y + pixels.height; y++) {
      for (let x = pixels.x - 1; x <= pixels.x + pixels.width; x++) {
        if (x >= pixels.x && x < pixels.x + pixels.width && y >= pixels.y && y < pixels.y + pixels.height) continue;
        assert.notDeepEqual(colorAt(x, y), expected, `${marker.id}: marker extends beyond its declared enclosure`);
      }
    }
    results.push({ id: marker.id, css, screen: native, pixels, checked_interior: interior, integral });
  }
  return { method: "root_web_area_dpr_enclosing", results, native_mapping_qualified: false,
    limitation: "Raster predicate only; caller must prove current selected source, native viewport and unchanged witness history." };
}

const keys = (value, expected) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
};
const boundedText = text => assert.ok(typeof text === "string" && text.length > 0 && text.length <= 512 && !text.includes("\0"));

/** Validate the actual opt-in native receipt; CSS geometry never supplies native evidence. */
export function validateNativeGeometry(r, { page, target, reference, marker, witness }) {
  keys(r, ["format", "status", "mode", "ref", "source_ref", "target_id", "tab_id", "source", "frame", "css_sample", "native", "physical_enclosing_rect", "clipped", "coordinate_space", "browser_version", "projection", "qualification", "atomic", "input_authority"]);
  assert.equal(r.format, "native_dom_geometry_v1"); assert.equal(r.status, "ok"); assert.equal(r.mode, "native_element_geometry");
  assert.equal(r.ref, reference); assert.equal(r.source_ref, reference);
  assert.equal(r.target_id, page.target_id); assert.equal(r.tab_id, page.tab_id);
  assert.deepEqual(r.frame, { kind: "main" });
  keys(r.source, ["frame_id", "loader_id", "backend_node_id", "context_unique_id", "generation"]);
  for (const name of ["frame_id", "loader_id", "context_unique_id"]) boundedText(r.source[name]);
  assert.ok(Number.isSafeInteger(r.source.backend_node_id) && r.source.backend_node_id > 0);
  assert.ok(Number.isSafeInteger(r.source.generation) && r.source.generation >= 0);
  assert.equal(r.qualification, "candidate_not_raster_qualified");
  assert.equal(r.atomic, false); assert.equal(r.input_authority, false); assert.equal(r.clipped, false);
  assert.equal(r.coordinate_space, "screen_physical_pixels");
  assert.equal(r.projection, "root_origin_plus_floor_start_ceil_end_at_sampled_dpr");
  keys(r.browser_version, ["product", "revision"]); boundedText(r.browser_version.product); boundedText(r.browser_version.revision);
  keys(r.native, ["platform", "pid", "window_id", "window", "viewport", "source", "automation_id", "framework", "opaque_runtime_id"]);
  assert.equal(r.native.platform, "windows"); assert.equal(r.native.pid, target.pid); assert.equal(r.native.window_id, target.window_id);
  assert.equal(r.native.source, "uia_root_web_area"); assert.equal(r.native.automation_id, "RootWebArea"); assert.equal(r.native.framework, "Chrome");
  assert.ok(Array.isArray(r.native.opaque_runtime_id) && r.native.opaque_runtime_id.length > 0 && r.native.opaque_runtime_id.length <= 64);
  assert.ok(r.native.opaque_runtime_id.every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647));
  for (const rectangle of [r.native.window, r.native.viewport, r.physical_enclosing_rect]) {
    keys(rectangle, rectKeys); checkRect(rectangle); assert.ok(Object.values(rectangle).every(Number.isSafeInteger));
  }
  const n = r.native, c = r.css_sample, w = witness.viewport;
  assert.ok(n.viewport.x >= n.window.x && n.viewport.y >= n.window.y && n.viewport.x + n.viewport.width <= n.window.x + n.window.width && n.viewport.y + n.viewport.height <= n.window.y + n.window.height);
  keys(c, ["connected", "same_document", "bounds", "scroll", "layout_viewport", "visual_viewport"]);
  assert.equal(c.connected, true); assert.equal(c.same_document, true);
  assert.deepEqual(c.layout_viewport, { width: w.width, height: w.height, dpr: w.dpr });
  assert.deepEqual(c.scroll, { x: w.scrollX, y: w.scrollY });
  assert.deepEqual(c.visual_viewport, w.visual);
  const css = { x: marker.x - w.scrollX, y: marker.y - w.scrollY, width: marker.width, height: marker.height };
  assert.deepEqual(c.bounds, css);
  assert.equal(w.width * w.dpr, n.viewport.width); assert.equal(w.height * w.dpr, n.viewport.height);
  const x = n.viewport.x + Math.floor(css.x * w.dpr), y = n.viewport.y + Math.floor(css.y * w.dpr);
  assert.deepEqual(r.physical_enclosing_rect, { x, y, width: Math.ceil((css.x + css.width) * w.dpr) - Math.floor(css.x * w.dpr), height: Math.ceil((css.y + css.height) * w.dpr) - Math.floor(css.y * w.dpr) });
  return structuredClone(r);
}

/** Compare ready samples only. Runtime IDs remain opaque; no DOM/native identity join. */
export function assertGeometryContinuity(before, after) {
  assert.ok(before.length >= 1 && before.length <= VIEWPORT_MARKERS.length);
  assert.deepEqual(after, before, "Ready CSS/native/source/browser samples changed.");
}

/** Source continuity across timer scrolls, excluding only refs and intentionally changing CSS positions. */
export function geometryDocumentIdentity(receipts) {
  assert.ok(receipts.length === VIEWPORT_MARKERS.length);
  return receipts.map(r => ({ source: r.source, native: r.native, browser_version: r.browser_version, target_id: r.target_id, tab_id: r.tab_id }));
}
/** Require one native browser-chrome edit, not a lookalike page control. */
export function assertAddressBar(overview, expectedValue) {
  assert.ok(Array.isArray(overview?.elements));
  const rows = overview.elements.filter(row => row.role === "Edit" && row.label === "Address and search bar" && row.in_web_content !== true);
  assert.equal(rows.length, 1, "No unique native address bar; no fallback.");
  if (expectedValue !== undefined) assert.equal(rows[0].value, expectedValue, "Address bar does not contain the exact fixture URL.");
  return rows[0];
}

/** Corroborate the selected owned window without adopting newly minted binding IDs.
 * This is not document identity by title: original refs and the independent witness
 * still supply document/context continuity through native geometry validation.
 */
export function assertSelectedNativeWindow(bound, url, title) {
  assert.equal(bound.status, "ok"); assert.equal(bound.mode, "bind");
  assert.equal(bound.binding_route, "native_cdp_window");
  assert.equal(bound.endpoint_access_class, "driver_owned");
  assertSelectedBridgeTab(bound, url, title);
  boundedText(bound.target_id); boundedText(bound.tabs[0].tab_id);
}
/** Require fresh exact-window admission on the current desktop before explicit native focus. */
export function assertNativeFocusAdmission(control, target) {
  assert.equal(control?.pid, target.pid); assert.equal(control?.window_id, target.window_id);
  boundedText(control.state_id); checkRect(control.state?.bounds);
  assert.ok(control.state_id.trim().length > 0, "A nonblank management state token is required.");
  assert.equal(typeof control.state.foreground_at_target, "boolean");
  assert.ok(Number.isSafeInteger(control.state.foreground_window) && control.state.foreground_window >= 0);
  assert.equal(control.state.foreground_at_target, control.state.foreground_window === target.window_id,
    "Foreground measurement must name the exact owned window.");
  assert.equal(control.state.minimized, false);
  assert.equal(control.state.virtual_desktop?.on_current_desktop, true, "Unknown desktop membership forbids activation.");
}
/** Admit the qualified native setup receipts only; separate native post-state still proves effects. */
export function assertSetupReceipt(result, { kind, pid, windowId, text, control } = {}) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const r = result.structuredContent;
  if (kind === "background") {
    assert.equal(result.isError, true);
    keys(r, ["code", "escalation", "event_kind", "suggestion", "target_class"]);
    assert.equal(r.code, "background_unavailable"); assert.equal(r.event_kind, "key_combo");
    assert.equal(r.target_class, "Chrome_WidgetWin_1");
    keys(r.escalation, ["reason", "recommended"]); assert.equal(r.escalation.recommended, "foreground");
    boundedText(r.escalation.reason); boundedText(r.suggestion); return;
  }
  assert.ok(!result.isError);
  if (kind === "native_focus") {
    assertNativeFocusAdmission(control, { pid, window_id: windowId });
    keys(r, ["pid", "window_id", "state_id", "operation", "requested_bounds", "mutation_attempted", "mutation_accepted", "postcondition_confirmed", "before", "observed", "route", "effect"]);
    assert.equal(r.pid, pid); assert.equal(r.window_id, windowId); assert.equal(r.state_id, control.state_id);
    assert.equal(r.operation, "focus"); assert.equal(r.requested_bounds, null);
    for (const key of ["mutation_attempted", "mutation_accepted", "postcondition_confirmed"]) assert.equal(r[key], true);
    assert.equal(r.route, "native"); assert.equal(r.effect, "confirmed");
    for (const sample of [r.before, r.observed]) {
      assert.deepEqual(sample?.bounds, control.state.bounds); assert.equal(sample.bounds_source, control.state.bounds_source);
      assertNativeFocusAdmission({ ...control, state: sample }, { pid, window_id: windowId });
    }
    assert.equal(r.observed.foreground_at_target, true); return;
  }
  let expected;
  if (kind === "type_text") {
    assert.ok(typeof text === "string" && /^[\x20-\x7e]+$/.test(text));
    expected = `✅ Typed ${text.length} char(s) on pid ${pid} via SendInput (delivery_mode:foreground).`;
  } else {
    assert.ok(["hotkey", "press_key"].includes(kind));
    expected = kind === "hotkey" ? `✅ Pressed ctrl+l on pid ${pid} via SendInput (Win32 target).`
      : `✅ Sent return via SendInput on pid ${pid} (delivery_mode:foreground).`;
  }
  // Core tool publication narrows all successful setup actions to this public projection.
  assert.deepEqual(r, { delivery: { mode: "foreground" }, effect: "unverifiable", route: "global_input", summary: expected });
  assert.deepEqual(result.content, [{ type: "text", text: expected }], "Unknown/partial setup acknowledgement; no replay.");
}

/** One explicit native-focus request; unknown/refused prefixes escape without retry or later setup. */
export async function establishNativeForeground({ state, call }, target) {
  const control = await state("setup-focus-admission", "get_window_control_state", target);
  assertNativeFocusAdmission(control, target);
  const focused = await call("setup-native-focus", "manage_window", { ...target, state_id: control.state_id, operation: "focus" });
  assertSetupReceipt(focused, { kind: "native_focus", pid: target.pid, windowId: target.window_id, control });
  const after = await state("setup-focus-native-poststate", "get_window_control_state", target);
  assertNativeFocusAdmission(after, target);
  assert.deepEqual(after.state.bounds, control.state.bounds);
  assert.equal(after.state.bounds_source, control.state.bounds_source);
  assert.equal(after.state.foreground_at_target, true);
}
/** Run one opt-in disposable-window proof. This never changes a provider profile or persistent setup. */
export async function runNativeGeometryProof(argv) {
  assert.equal(argv.length, 3, "Usage: node --experimental-transform-types scripts/dom-native-geometry-proof.mjs --live-approved ARTIFACT_DIR EXPECTED_SOURCE");
  assert.equal(argv[0], "--live-approved");
  const expectedSource = "91989b6309884473e07c6cdb136ae6092a40eff3";
  const expectedHash = "8ed27ba88b082b4c04f7a2bed88fcbcf48a29ed03205db8eeb0a5ab54279e9cc";
  assert.equal(argv[2], expectedSource, "Only the reviewed strict-geometry source is admitted.");
  const artifactDirectory = resolve(argv[1]);
  assert.equal((await readFile(resolve(artifactDirectory, "source-sha.txt"), "utf8")).trim(), expectedSource);
  assert.equal(createHash("sha256").update(await readFile(resolve(artifactDirectory, "runtime/cua-driver.exe"))).digest("hex"), expectedHash);
  // Imports are deliberately deferred: pure tests and imports cannot start the native process.
  const [{ openForkArtifact }, { validateDomSnapshot }, { default: sharp }] = await Promise.all([
    import("./check-cua-fork-artifact.mjs"), import("../src/dom-inspection.ts"), import("sharp"),
  ]);
  const nonce = randomUUID(), title = `Pi viewport proof ${nonce}`, session = `pi-viewport-proof-${randomUUID()}`;
  const directory = resolve(".tmp", "lpt-733-native-geometry", `${Date.now()}-${nonce}`);
  await mkdir(directory, { recursive: true });
  const { html, script } = createViewportProofPage(nonce);
  const records = [], reports = [], proofs = [], pending = new Set(), inputLabels = new Set();
  let setupFinished = false;
  const abort = new AbortController();
  const deadline = Date.now() + 100000; // Native calls are aborted here; cleanup has its own <=15s budget.
  let stopping = false, cancelled = false, started = false, artifact, target, page, url, baseline, documentIdentity, rejected = 0, failure;
  const stop = () => { stopping = true; cancelled = true; abort.abort(new Error("Cancelled/deadline; no replay.")); };
  const timer = setTimeout(stop, 100000);
  const watchdog = setTimeout(() => { console.error("120-second hard deadline: owned cleanup remains unconfirmed; inspect saved evidence, do not replay."); process.exit(124); }, 120000);
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const server = createServer((req, res) => {
    const handling = handle(req, res); pending.add(handling);
    void handling.then(() => pending.delete(handling), () => { pending.delete(handling); rejected++; res.destroy(); });
  });
  server.requestTimeout = 2000; server.headersTimeout = 2000; server.maxConnections = 8;
  async function handle(req, res) {
    const origin = `http://${req.headers.host}`;
    if (origin !== url?.slice(0, -1)) { rejected++; res.writeHead(400).end(); return; }
    if (req.method === "GET" && ["/", "/fixture.js"].includes(req.url)) {
      res.writeHead(200, { "Content-Type": req.url === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'" });
      res.end(req.url === "/" ? html : script); return;
    }
    if (req.method !== "POST" || req.url !== "/witness") { res.writeHead(404).end(); return; }
    try {
      assert.equal(req.headers.origin, origin); assert.equal(req.headers["content-type"], "application/json");
      req.setTimeout(2000, () => req.destroy()); req.setEncoding("utf8");
      let body = "";
      for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 16384); }
      const report = validateViewportReport(JSON.parse(body), nonce, url);
      assert.ok(reports.length < 500);
      const retained = { ...report, received_ms: Date.now() };
      // Validate cumulative prefixes before retaining; failures stay visible in rejected.
      assertViewportHistory([...reports, retained], nonce, url, rejected, baseline);
      reports.push(retained); res.writeHead(204).end();
    } catch { rejected++; req.resume(); if (!res.destroyed) res.writeHead(400).end(); }
  }
  const save = () => writeFile(resolve(directory, "run.json"), JSON.stringify({ source: expectedSource, binary_sha256: expectedHash, nonce, title, session, url, target, page, records, reports, rejected, baseline, proofs,
    failure, cancelled, production_mapping_qualified: false, input_authority: false }, null, 2) + "\n");
  const ensureRunning = () => { assert.ok(!stopping && Date.now() < deadline, "Cancelled/deadline; no later dispatch."); };
  async function call(label, name, args = {}, { allowRefusal = false, cleanup = false } = {}) {
    assertBridgeDispatchAllowed(stopping, name);
    if (!cleanup) ensureRunning();
    assert.ok(["start_session", "end_session", "browser_prepare", "list_windows", "get_window_state", "get_window_control_state", "manage_window", "get_browser_state", "hotkey", "type_text", "press_key"].includes(name));
    assert.ok(records.length < 160 || cleanup);
    if (["hotkey", "type_text", "press_key", "manage_window"].includes(name)) {
      assert.ok(!setupFinished && !inputLabels.has(label), "No input after setup and no input replay.");
      assert.ok(["setup-background-ctrl-l", "setup-native-focus", "setup-foreground-ctrl-l", "setup-literal-url", "setup-return"].includes(label));
      inputLabels.add(label); assert.ok(inputLabels.size <= 5);
      if (name === "manage_window") assert.equal(args.operation, "focus");
    }
    const request = { ...args, session };
    if (name === "get_window_state") await writeFile(resolve(directory, `${label}-CAPTURE-INTENT.json`), JSON.stringify({ target, args, purpose: label.startsWith("phase") ? "predeclared raster proof; see phase PREDECLARED plan" : "native browser chrome setup overview only; not raster qualification" }, null, 2) + "\n");
    let result;
    const startedAt = Date.now();
    try {
      result = await artifact.client.callTool({ name, arguments: request }, undefined, {
        timeout: cleanup ? 10000 : Math.max(1, Math.min(15000, deadline - Date.now())),
        ...(cleanup ? {} : { signal: abort.signal }),
      });
    } catch (error) {
      records.push({ label, name, args, outcome: "unknown; not replayed", error: String(error) }); await save(); throw error;
    }
    const images = [];
    for (const block of result.content ?? []) if (block.type === "image") {
      assert.equal(name, "get_window_state"); assert.equal(block.mimeType, "image/png"); assert.equal(images.length, 0);
      const bytes = Buffer.from(block.data, "base64"); assert.ok(bytes.length <= 32 * 1024 * 1024);
      const file = `${label}.png`; await writeFile(resolve(directory, file), bytes); images.push(file);
    }
    records.push({ label, name, args, elapsed_ms: Date.now() - startedAt, structuredContent: result.structuredContent,
      isError: result.isError ?? false, text: (result.content ?? []).filter(x => x.type === "text").map(x => x.text), images });
    await save();
    if (!allowRefusal) assert.ok(!result.isError && !result.structuredContent?.refusal && !result.structuredContent?.error && !["refused", "unknown"].includes(result.structuredContent?.status), `${label} refused/unknown; no fallback.`);
    return result;
  }
  const state = async (label, name, args = {}) => {
    const result = await call(label, name, args); assert.ok(result.structuredContent); return result.structuredContent;
  };
  async function overview(label) {
    const result = await state(label, "get_window_state", { ...target, include_screenshot: true, include_accessibility_tree: true, max_image_dimension: 900, max_elements: 200, max_depth: 24 });
    assert.ok(Array.isArray(result.elements) && result.elements.length > 0); return result;
  }
  async function foreground(label) {
    const control = await state(label, "get_window_control_state", target);
    assertNativeFocusAdmission(control, target);
    assert.equal(control.state.foreground_at_target, true);
    assert.equal(control.state.keyboard_focus_at_target, true);
  }
  async function selected(label) {
    const r = await state(label, "get_browser_state", target);
    // Bind mode always mints fresh diagnostic IDs. Keep the original `page`
    // for every subsequent snapshot/geometry request; never retarget its refs.
    assertSelectedNativeWindow(r, url, title);
  }
  async function witness(stage, wait = false) {
    while (true) {
      ensureRunning();
      const latest = reports.at(-1);
      assert.equal(rejected, 0, "A rejected independent report stops immediately.");
      if (latest && latest.stage === stage) {
        assertViewportHistory(reports, nonce, url, rejected, baseline);
        assert.ok(Date.now() - latest.received_ms <= 1500, "Stale independent witness."); return latest;
      }
      assert.ok(wait && (!latest || latest.stage < stage), "Fixture stage crossed sampling; stop.");
      await delay(100, undefined, { signal: abort.signal });
    }
  }
  async function inspect(stage, label) {
    await selected(`${label}-selected`); await witness(stage);
    const raw = await state(label, "get_browser_state", { ...page, snapshot_format: "dom_inspect_v1", include_screenshot: false,
      include_hidden: true, max_nodes: 200, max_depth: 32, locator: { css: "[data-testid^='raster-']" } });
    const snapshot = validateDomSnapshot(raw, page, 200);
    assert.equal(snapshot.collection_complete, true); assert.equal(snapshot.elements.length, 4);
    return VIEWPORT_MARKERS.map(marker => {
      const rows = snapshot.elements.filter(row => row.attributes.id === marker.id && row.frame.kind === "main");
      assert.equal(rows.length, 1); return rows[0].ref;
    });
  }
  async function sample(stage, refs, label) {
    const receipts = [];
    for (const [index, marker] of VIEWPORT_MARKERS.entries()) {
      const w = await witness(stage); await selected(`${label}-${index}-selected-before`);
      const raw = await state(`${label}-${index}`, "get_browser_state", { ...page, snapshot_format: "dom_inspect_v1", native_geometry_ref: refs[index] });
      const r = validateNativeGeometry(raw, { page, target, reference: refs[index], marker, witness: w });
      await witness(stage); receipts.push(r);
      if (receipts.length > 1) {
        assert.deepEqual(r.native, receipts[0].native); assert.deepEqual(r.browser_version, receipts[0].browser_version);
        const { backend_node_id: ignored, ...common } = r.source;
        const { backend_node_id: ignoredFirst, ...first } = receipts[0].source;
        assert.deepEqual(common, first);
      }
    }
    await selected(`${label}-selected-after`); return receipts;
  }
  async function phase(stage) {
    await witness(stage, true);
    const refs = await inspect(stage, `phase${stage}-snapshot`);
    const before = await sample(stage, refs, `phase${stage}-before`);
    const confirmed = await sample(stage, refs, `phase${stage}-ready-confirmation`);
    const identity = geometryDocumentIdentity(before);
    if (documentIdentity) assert.deepEqual(identity, documentIdentity, "Document/native/browser identity changed across timer scroll.");
    else documentIdentity = identity;
    assertGeometryContinuity(before, confirmed);
    const w = await witness(stage);
    const plan = { rule: "native RootWebArea origin + floor(start CSS edge * sampled DPR), ceil(end)", stage, receipts: before, witness: w };
    await writeFile(resolve(directory, `phase${stage}-PREDECLARED.json`), JSON.stringify(plan, null, 2) + "\n");
    await foreground(`phase${stage}-native-control`); await witness(stage);
    const captured = await state(`phase${stage}-native`, "get_window_state", { ...target, capture_backend: "wgc", include_accessibility_tree: false, max_image_dimension: 0 });
    await witness(stage);
    const after = await sample(stage, refs, `phase${stage}-after`); assertGeometryContinuity(before, after);
    const png = await readFile(resolve(directory, `phase${stage}-native.png`));
    assert.ok(png.length >= 26 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(png[24], 8); assert.ok([2, 6].includes(png[25]));
    const { data, info } = await sharp(png, { limitInputPixels: 16000000, ignoreIcc: true }).ensureAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    const proof = verifyViewportRaster({ rgba: data, width: info.width, height: info.height, capture: captured, nativeViewport: before[0].native.viewport,
      layout: before[0].css_sample.layout_viewport, scroll: before[0].css_sample.scroll,
      samples: before.map((r, i) => ({ id: VIEWPORT_MARKERS[i].id, css: r.css_sample.bounds, screen: r.physical_enclosing_rect })) });
    proofs.push({ stage, image_sha256: createHash("sha256").update(png).digest("hex"), proof }); await save();
  }
  const bounded = async (promise, ms, label) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(Error(`${label} cleanup timed out.`)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const cleanup = {};
  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
    url = `http://127.0.0.1:${server.address().port}/`;
    artifact = await openForkArtifact(artifactDirectory, expectedSource); assert.equal(artifact.report.binary_sha256, expectedHash);
    const discovery = await artifact.client.listTools(undefined, { timeout: Math.min(15000, deadline - Date.now()), signal: abort.signal });
    assert.ok(!discovery.nextCursor); await writeFile(resolve(directory, "tools.json"), JSON.stringify(discovery, null, 2) + "\n");
    const properties = name => { const tool = discovery.tools.find(row => row.name === name); assert.ok(tool); return tool.inputSchema.properties; };
    assert.equal(properties("get_browser_state").native_geometry_ref.type, "string");
    assert.ok(properties("get_window_state").capture_backend.enum.includes("wgc"));
    assert.equal(properties("get_window_state").max_image_dimension.minimum, 0);
    assert.ok(properties("manage_window").operation.enum.includes("focus"));
    assert.equal(properties("manage_window").state_id.type, "string");
    for (const name of ["hotkey", "type_text", "press_key"]) {
      const p = properties(name); assert.equal(p.pid.type, "integer"); assert.equal(p.window_id.type, "integer");
      assert.deepEqual(p.delivery_mode.enum, ["background", "foreground"]);
    }
    assert.equal(properties("hotkey").keys.type, "array"); assert.equal(properties("press_key").key.type, "string"); assert.equal(properties("type_text").text.type, "string");
    started = true; await state("start", "start_session");
    const prepared = await state("prepare", "browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } });
    assert.equal(prepared.prepared, true); assert.ok(Number.isSafeInteger(prepared.prepared_pid) && prepared.prepared_pid > 0);
    const windows = (await state("owned-window", "list_windows", { pid: prepared.prepared_pid })).windows;
    assert.equal(windows.length, 1); target = { pid: windows[0].pid, window_id: windows[0].window_id };
    assert.equal(target.pid, prepared.prepared_pid); assert.ok(Number.isSafeInteger(target.window_id) && target.window_id > 0);
    const bound = await state("bind", "get_browser_state", target);
    assert.equal(bound.binding_quality, "exact"); assert.equal(bound.tabs.length, 1); assert.equal(bound.tabs[0].active, true);
    page = { target_id: bound.target_id, tab_id: bound.tabs[0].tab_id };
    // Known browser chrome only: no DOM locator, coordinate or native-focus fallback.
    assertAddressBar(await overview("setup-overview"));
    const refused = await call("setup-background-ctrl-l", "hotkey", { ...target, keys: ["ctrl", "l"], delivery_mode: "background" }, { allowRefusal: true });
    assertSetupReceipt(refused, { kind: "background", pid: target.pid });
    assertAddressBar(await overview("setup-fresh-overview"));
    // Foreground keyboard transport restores its prior foreground: explicitly establish the owned window first.
    // This is one native focus request from fresh state, never a key/pointer fallback or retry.
    await establishNativeForeground({ state, call }, target);
    assertAddressBar(await overview("setup-focused-overview"));
    assertSetupReceipt(await call("setup-foreground-ctrl-l", "hotkey", { ...target, keys: ["ctrl", "l"], delivery_mode: "foreground" }), { kind: "hotkey", pid: target.pid });
    await foreground("setup-ctrl-l-native-poststate"); assertAddressBar(await overview("setup-address-bar-before-text"));
    assertSetupReceipt(await call("setup-literal-url", "type_text", { ...target, text: url, delivery_mode: "foreground", delay_ms: 0 }), { kind: "type_text", pid: target.pid, text: url });
    await foreground("setup-text-native-poststate"); assertAddressBar(await overview("setup-fresh-address-proof"), url);
    assertSetupReceipt(await call("setup-return", "press_key", { ...target, key: "return", delivery_mode: "foreground" }), { kind: "press_key", pid: target.pid });
    setupFinished = true;
    await foreground("setup-return-native-poststate"); await witness(0, true); await selected("setup-exact-fixture-selected");
    const initial = await witness(0);
    await delay(300, undefined, { signal: abort.signal });
    const settled = await witness(0); assert.ok(settled.serial > initial.serial, "Need a fresh independent setup report.");
    baseline = { serial: settled.serial, events: structuredClone(settled.events) }; await save();
    // One unqualified bootstrap. Only a known readiness refusal permits a fresh DOM/AX read.
    const refs = await inspect(0, "bootstrap-snapshot");
    const bootstrap = await call("unqualified-native-bootstrap", "get_browser_state", { ...page, snapshot_format: "dom_inspect_v1", native_geometry_ref: refs[0] }, { allowRefusal: true });
    if (bootstrap.isError || bootstrap.structuredContent?.refusal) {
      assert.equal(bootstrap.structuredContent?.refusal?.code, "browser_route_unavailable");
      assert.equal(bootstrap.structuredContent.refusal.message, "native RootWebArea is pending, changed, ambiguous or incomplete");
      await selected("bootstrap-fresh-guarded-AX-read");
    } else validateNativeGeometry(bootstrap.structuredContent, { page, target, reference: refs[0], marker: VIEWPORT_MARKERS[0], witness: await witness(0) });
    await phase(0); await phase(1);
  } catch (error) { failure = String(error); process.exitCode = 1; }
  finally {
    stopping = true; abort.abort();
    try { if (started) { const ended = await call("end", "end_session", {}, { cleanup: true }); cleanup.session_ended = ended.structuredContent?.active === false; assert.equal(cleanup.session_ended, true); } }
    catch (error) { cleanup.end_error = String(error); process.exitCode = 1; }
    const release = await Promise.allSettled([
      bounded(Promise.resolve().then(() => artifact?.close()), 5000, "SDK"),
      bounded(closePixelProbeServer(server), 5000, "HTTP"),
      bounded(Promise.allSettled([...pending]), 5000, "HTTP requests"),
    ]);
    cleanup.release_errors = release.flatMap(r => r.status === "rejected" ? [String(r.reason)] : []);
    try { assertViewportHistory(reports, nonce, url, rejected, baseline); cleanup.witness_integrity = true; }
    catch (error) { cleanup.witness_error = String(error); process.exitCode = 1; }
    if (cleanup.release_errors.length) process.exitCode = 1;
    clearTimeout(timer); clearTimeout(watchdog); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    await save(); await writeFile(resolve(directory, "cleanup.json"), JSON.stringify(cleanup, null, 2) + "\n");
    console.log(JSON.stringify({ directory, prototype_predicate_passed: proofs.length === 2 && !failure && !cancelled && cleanup.witness_integrity === true && cleanup.session_ended === true && cleanup.release_errors.length === 0,
      production_mapping_qualified: false, input_authority: false, cancelled, failure, cleanup }));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runNativeGeometryProof(process.argv.slice(2));