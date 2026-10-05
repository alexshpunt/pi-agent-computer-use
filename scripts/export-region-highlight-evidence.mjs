import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Publish an allowlisted metadata summary, never private desktop pixels, text, IDs or URLs.
const [nativeFile, geometryFile, previewFile, settingsFile, cleanupFile, helperFile, destination] = process.argv.slice(2);
for (const file of [nativeFile, geometryFile, previewFile, settingsFile, cleanupFile]) assert.ok(file?.startsWith(".tmp/region-highlights/"));
assert.equal(destination, "docs/evidence/region-highlights/run.json");
const json = async file => JSON.parse(await readFile(file, "utf8"));
const [native, geometry, preview, settings, cleanup] = await Promise.all([nativeFile, geometryFile, previewFile, settingsFile, cleanupFile].map(json));
assert.equal(native.success, true); assert.equal(geometry.success, true); assert.equal(geometry.cleanup, "closed");
assert.equal(cleanup.OwnedWindowPresent, false); assert.equal(cleanup.OwnedBrowserPresent, false);
assert.equal(cleanup.DriverCount, 0); assert.equal(cleanup.HelperCount, 0); assert.equal(cleanup.Profiles, 0);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const styles = native.records.filter(r => r.label.startsWith("renderer-"));
assert.equal(styles.length, 6);
for (const style of styles) { assert.equal(style.focus_unchanged, true); assert.equal(style.identical_owned_region_pixels, true); }
const counts = ["after-ax-action", "after-pixel-action"].map(label => {
  const record = native.records.find(r => r.label === label);
  const matches = record.details.state.elements.map(e => e.label).filter(s => /^Selections: \d+$/.test(s));
  assert.equal(matches.length, 1); return Number(matches[0].split(": ")[1]);
});
assert.deepEqual(counts, [1, 2]);
for (const record of geometry.records) {
  assert.ok(["baseline", "move", "shrink", "grow"].includes(record.label));
  assert.equal(hash(await readFile(path.join(path.dirname(geometryFile), `${record.label}.jpg`))), record.output.hash);
}
assert.equal(native.calls.filter(c => c.name === "click").length, 2);
const captures = [];
for (const frame of preview.captures) {
  const bytes = await readFile(path.join(path.dirname(previewFile), frame.filename));
  assert.equal(hash(bytes), frame.hash);
  assert.deepEqual(frame.source.observation.image.dimensions, { width: frame.width, height: frame.height });
  captures.push({ mime: frame.mime, width: frame.width, height: frame.height, bytes: frame.bytes, hash: frame.hash,
    scope: frame.source.observation.image.scope, coordinate_space: frame.source.observation.image.coordinate_space,
    input: frame.source.observation.capabilities.input, final_delivery: frame.finalDelivery });
}
assert.ok(captures.some(c => c.mime === "image/jpeg" && c.input === "none"));
assert.equal(settings.imageSettings.maxLongEdge, 1024); assert.equal(settings.imageSettings.scale, 1);
const settingsCapture = settings.captures.find(c => c.configuration.effective.configuration?.maxLongEdge === 1024);
assert.ok(settingsCapture); assert.equal(hash(await readFile(path.join(path.dirname(settingsFile), settingsCapture.filename))), settingsCapture.hash);
const helperHash = hash(await readFile(helperFile));
assert.equal(helperHash, "c79a10981ab3e345a10950f90858224fdbad34ad43db5215451cc95586980b01");
const evidence = {
  task: "LPT-415", driver: "0.33.2", helper: { protocol: 2, qt: "6.11.3", executable_sha256: helperHash },
  native: { call_count: native.calls.length, record_count: native.records.length,
    styles: styles.map(r => ({ kind: r.kind, focus_unchanged: r.focus_unchanged, capture_pixels_identical: r.identical_owned_region_pixels })),
    expiry_hidden: native.records.find(r => r.label === "expired").visible === false,
    stale_frame_hidden: native.records.find(r => r.label === "stale-geometry").visible === false,
    single_action_counts: counts },
  geometry: geometry.records.map(r => ({ case: r.label, output: r.output, highlight: { kind: r.highlight.kind, status: r.highlight.status,
    width: r.highlight.region.width, height: r.highlight.region.height } })),
  parent: { preview_revision: preview.revision, captures, restored_settings: { maxLongEdge: 1024, scale: 1,
    output: { width: settingsCapture.width, height: settingsCapture.height } } },
  cleanup: { window_gone: !cleanup.OwnedWindowPresent, browser_gone: !cleanup.OwnedBrowserPresent,
    drivers: cleanup.DriverCount, helpers: cleanup.HelperCount, profiles: cleanup.Profiles, checked_at: cleanup.checkedAt },
};
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ destination, styles: styles.length, geometry_cases: geometry.records.length, parent_captures: captures.length }));
