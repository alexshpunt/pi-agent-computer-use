import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";

// Export allowlisted geometry/cost metadata only. Never copy private desktop pixels or source text.
const [release, parentPath, ...runs] = process.argv.slice(2);
assert.ok(release && parentPath && runs.length >= 3, "Pass final release, parent metadata and at least three native run files.");
const read = async path => JSON.parse(await readFile(path, "utf8"));
const manifest = await read(`${release}/manifest.json`);
assert.equal(manifest.source_supplied, true);
const samples = [];
for (const path of runs) {
  const { records } = await read(path);
  const record = label => { const found = records.find(r => r.label === label); assert.ok(found, label); return found; };
  const ready = record("ready"), flash = record("flash"), active = record("active"), expired = record("expired"), cleanup = record("cleanup");
  assert.equal(flash.native.status, "shown");
  assert.equal(flash.native.focus_unchanged, true); assert.equal(flash.native.foreground_unchanged, true);
  assert.equal(active.state.Visible, true); assert.equal(active.state.Affinity, 17);
  assert.equal(active.identical_owned_region_pixels, true);
  assert.equal(expired.state.Visible, false);
  assert.equal(cleanup.state.Present, false); assert.equal(cleanup.state.SourcePresent, false);
  samples.push({ startup_ms: ready.startup_ms,
    ready: { working_set_bytes: ready.state.WorkingSet, private_bytes: ready.state.PrivateBytes },
    active: { working_set_bytes: active.state.WorkingSet, private_bytes: active.state.PrivateBytes },
    expired: { working_set_bytes: expired.state.WorkingSet, private_bytes: expired.state.PrivateBytes },
    duration_ms: flash.native.duration_ms, focus_unchanged: true, foreground_unchanged: true,
    capture_affinity: 17, identical_owned_region_pixels: true, expired_hidden: true, cleanup_absent: true });
}
const parent = (await read(parentPath)).map(v => {
  assert.equal(v.status, "observed"); assert.equal(v.highlight.status, "shown");
  return { operation: v.operation, source_kind: v.source.kind, image_scope: v.source.image.scope,
    dimensions: v.source.image.dimensions, coordinate_space: v.source.image.coordinate_space,
    mime_type: v.agent_image.output.mimeType, image_sha256: v.agent_image.output.hash, highlight: v.highlight };
});
const result = { platform: "Windows host from WSL", cua: "0.33.2", qt: manifest.qt, qt_revision: manifest.qt_revision,
  runtime: { binary_files: manifest.files.filter(f => /runtime\/(?:Qt6.*\.dll|pi-window-overlay\.exe|platforms\/qwindows\.dll|qt\.conf)$/.test(f.path)),
    bytes_with_notices: manifest.runtime_bytes, compressed_bytes: manifest.runtime_archive_bytes,
    total_bytes_with_corresponding_source: manifest.total_bytes, source_supplied: true },
  measurements: { protocol: "Three repeated warm helper starts; one ready, visible and expired memory sample each. Not controlled cold-cache or a steady-state stress test.", samples },
  parent, privacy: "No private pixels, source text, native identities, session IDs or viewer URLs exported." };
await mkdir("docs/evidence/window-overlay", { recursive: true });
await writeFile("docs/evidence/window-overlay/run.json", JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ samples: samples.length, parent: parent.length, output: "docs/evidence/window-overlay/run.json" }));
