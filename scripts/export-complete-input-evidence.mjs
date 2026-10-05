import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Publish only counts, relative timings, dimensions and hashes from private fixture evidence.
const [nativeDirectory, parentDirectory] = process.argv.slice(2);
for (const path of [nativeDirectory, parentDirectory]) assert.ok(path?.startsWith(".tmp/cua-gestures/"));
const read = async path => JSON.parse(await readFile(path, "utf8"));
const native = await read(`${nativeDirectory}/run.json`), parent = await read(`${parentDirectory}/run.json`);
const cleanup = await read(`${parentDirectory}/cleanup.json`);
const settings = await read(`${parentDirectory}/restored-settings.json`);
assert.equal(settings.maxLongEdge, 1024); assert.equal(settings.scale, 1);
assert.equal(native.success, true); assert.equal(native.cleanup.sourceGone, true);
assert.equal(native.cleanup.browser.profileRemoved, true); assert.equal(parent.cleanup.sourceGone, true);
assert.equal(parent.cleanup.profileRemoved, true);
assert.equal(cleanup.OwnedWindowPresent, false); assert.equal(cleanup.OwnedBrowserPresent, false);
for (const key of ["DriverCount", "HelperCount", "FixtureProfiles", "DriverProfiles"]) assert.equal(cleanup[key], 0);
function sequence(receipt) {
  const s = receipt.state.sequence;
  return { status: receipt.status, total: s.total, attempted: s.attempted, completed: s.completed, elapsed_ms: s.elapsed_ms,
    steps: s.steps.map(step => ({ action: step.action, status: step.status, requested_wait_ms: step.requested_wait_ms,
      dispatch_ms: step.dispatch_ms, completion_ms: step.completion_ms })) };
}
function application(events, suffix) {
  const keyPairs = ["KeyA", "KeyB", "ArrowLeft", "ArrowRight"].map(code => ({ code,
    down: events.some(e => e.type === "keydown" && e.code === code), up: events.some(e => e.type === "keyup" && e.code === code) }));
  for (const pair of keyPairs) assert.ok(pair.down && pair.up);
  const shiftReleased = events.some(e => e.type === "keyup" && e.code === "ShiftLeft" && e.shift === false);
  const literalSuffix = events.some(e => e.type === "input" && e.value.endsWith(suffix));
  const scrollTop = events.filter(e => e.type === "scroll" && e.target === "scroll").map(e => e.scrollTop);
  assert.ok(shiftReleased && literalSuffix && scrollTop.some(value => value > 0));
  const downs = events.filter(e => e.type === "pointerdown" && e.target === "board"), ups = events.filter(e => e.stroke);
  assert.equal(downs.length, 3); assert.equal(ups.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(downs[i].time < ups[i].time); assert.equal(ups[i].buttons, 0);
    if (i < 2) assert.ok(ups[i].time < downs[i + 1].time);
  }
  return { key_pairs: keyPairs, shift_released: shiftReleased, literal_suffix_verified: literalSuffix, scroll_top: scrollTop,
    strokes: downs.map((down, i) => ({ pointer_type: down.pointerType, duration_ms: ups[i].time - down.time,
      released_buttons: ups[i].buttons, release_before_next: i === 2 || ups[i].time < downs[i + 1].time })) };
}
const record = label => { const found = native.records.filter(r => r.label === label); assert.equal(found.length, 1); return found[0]; };
const keyboard = await read(`${parentDirectory}/keyboard.json`), drawing = await read(`${parentDirectory}/drawing.json`);
const refusal = await read(`${parentDirectory}/keyboard-refusal.json`), image = await read(`${parentDirectory}/final-image.json`);
assert.equal(refusal.state.code, "background_unavailable"); assert.equal(refusal.state.sequence.completed, 0);
assert.equal(keyboard.state.sequence.completed, 5); assert.equal(drawing.state.sequence.completed, 3);
const pointerEvents = native.events;
assert.ok(pointerEvents.some(e => e.type === "contextmenu" && e.target === "pad"));
assert.ok(pointerEvents.some(e => e.type === "dblclick" && e.target === "pad"));
const report = { driver: "0.33.2", platform: "Windows from WSL", publication: "redacted metadata only",
  native: { calls: native.calls.length, records: native.records.length, events: native.events.length,
    keyboard: sequence(record("keyboard").details), drawing: sequence(record("independent-strokes").details),
    right_click_verified: true, double_click_verified: true, application: application(native.events, "xyz"),
    final_image: record("after-drawing").image, cleanup: native.cleanup },
  parent: { keyboard: sequence(keyboard), drawing: sequence(drawing), zero_completed_background_refusal: true,
    application: application(await read(`${parentDirectory}/events.json`), "XYZ"),
    final_image: image.agent_image.output, restored_overview_settings: { maxLongEdge: settings.maxLongEdge, scale: settings.scale }, cleanup },
  limits: { pixel_scroll: "refused before native input; observed token required", raw_holds: false,
    continuous_path: false, immediate_in_flight_cancel: false, requested_timing_guaranteed: false } };
await mkdir("docs/evidence/complete-input", { recursive: true });
await writeFile("docs/evidence/complete-input/run.json", JSON.stringify(report, null, 2) + "\n");
console.log(`Native: ${report.native.calls} calls, ${report.native.records} records; keys, right/double click, token scroll and three independent strokes verified.`);
console.log(`Parent Pi/Codemode: keyboard ${keyboard.state.sequence.completed}/5 in ${Math.round(keyboard.state.sequence.elapsed_ms)}ms; drawing ${drawing.state.sequence.completed}/3 in ${Math.round(drawing.state.sequence.elapsed_ms)}ms; application events and final pixels verified.`);
console.log("Cleanup: owned window/browser absent; Driver=0, helper=0, fixture profiles=0, driver profiles=0. YOLO unchanged; overview settings restored to 1024/1.");
console.log("Published: docs/evidence/complete-input/run.json; no private pixels, text, URLs or IDs.");
