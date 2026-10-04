import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Publish geometry and hashes only. Private native pixels, identities and action text never leave .tmp.
const root = ".tmp/native-zoom";
const read = async name => JSON.parse(await readFile(path.join(root, name), "utf8"));
const qualification = await read("qualification/run.json");
const native = await read("native/run.json");
const display = await read("parent/display-metadata.json");
const window = await read("parent/window-metadata.json");
const cleanup = await read("parent-ui-fixed/cleanup.json");
const ui = await read("parent-ui-fixed/verification.json");
const zipHash = createHash("sha256").update(await readFile(path.join(root, "runtime/cua-driver-rs-0.33.2-windows-x86_64-binary.zip"))).digest("hex");
assert.equal(zipHash, "82fd647e6f4b69ed811e52e9586a4e56291e477ad699fb02441193a45364337c");
assert.equal(qualification.success, true);
assert.equal(native.success, true);
assert.equal(qualification.version, "0.33.2");
assert.equal(native.version, qualification.version);
assert.deepEqual([cleanup.OwnedBrowserPresent, cleanup.OwnedWindowPresent, cleanup.DriverCount, cleanup.Profiles], [false, false, 0, 0]);
for (const key of ["oldInputDispatches", "nestedCaptureDispatches", "rawPixelsForwarded"]) assert.equal(native[key], 0);

function geometry(view) {
  const { source, agent_image: frame } = view;
  const overview = frame.region?.overview;
  assert.equal(source.capabilities.input, "none");
  return {
    kind: source.kind, domain: source.domain, scope: source.image.scope,
    coordinateSpace: source.image.coordinate_space, dimensions: source.image.dimensions,
    originalDimensions: source.image.original_dimensions, origin: source.image.origin,
    route: frame.route, configuration: frame.configuration, output: frame.output,
    region: overview ? {
      overview: { dimensions: overview.dimensions, x: overview.x, y: overview.y, width: overview.width, height: overview.height },
      native: frame.region.native ?? null,
    } : null,
    input: "none", paintFreshness: source.visibility.paint_freshness,
  };
}

async function verifyPreview(name, view) {
  const folder = `parent/${name}-preview`;
  const preview = await read(`${folder}/run.json`);
  const frame = preview.captures.find(item => item.hash === view.agent_image.output.hash);
  assert.ok(frame, "Returned frame must exist in the exact preview export.");
  assert.equal(path.basename(frame.filename), frame.filename);
  const bytes = await readFile(path.join(root, folder, frame.filename));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), view.agent_image.output.hash);
  assert.equal(bytes.length, view.agent_image.output.bytes);
  assert.deepEqual(frame.source.observation, view.source);
  assert.deepEqual(frame.configuration.effective, view.agent_image);
  return { revision: preview.revision, exactBytes: true, sourceAndRegionPreserved: true };
}

const evidence = {
  runtime: {
    version: qualification.version,
    zipSha256: zipHash,
    qualificationCalls: qualification.calls.length,
    retiredHintDispatches: qualification.staleHintDispatches,
  },
  native: {
    calls: native.calls.length, imageRecords: native.records.length,
    oldInputDispatches: native.oldInputDispatches, nestedCaptureDispatches: native.nestedCaptureDispatches,
    rawPixelsForwarded: native.rawPixelsForwarded,
  },
  parent: {
    displayOverview: geometry(display.overview), displayDetail: geometry(display.detail), windowDetail: geometry(window),
    displayPreview: await verifyPreview("display", display.detail), windowPreview: await verifyPreview("window", window),
    tui: { revision: ui.tui.revision, readableMetadata: ui.tui.readableMetadata, collapsedImages: ui.tui.collapsedImages },
    correctedViewerLabels: ui.correctedViewerLabels,
  },
  cleanup: { ownedWindowPresent: false, ownedBrowserPresent: false, driverCount: 0, profiles: 0, checkedAt: cleanup.checkedAt, operation: cleanup.operation },
  privacy: "No pixels, window text, native identities, viewer URLs or sessions are published.",
};
const destination = "docs/evidence/native-detail";
await mkdir(destination, { recursive: true });
await writeFile(`${destination}/run.json`, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ exported: `${destination}/run.json`, pixelsPublished: 0, previewHashesVerified: 2 }));
