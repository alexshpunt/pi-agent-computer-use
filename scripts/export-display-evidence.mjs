import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Export metadata only. Private desktop pixels and window text must never enter the report.
const root = process.argv[2] ?? ".tmp/display-observation";
const previewRoot = process.argv[3] ?? ".tmp/cua-pivot/display376-preview-fixed";
const destination = "docs/evidence/display-observation";
const json = async file => JSON.parse(await readFile(file, "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const source = value => {
  assert.equal(value.domain, "windows-host");
  assert.ok(["display", "window", "browser"].includes(value.kind));
  return Object.fromEntries(["kind", "domain", "identity", "captured_at", "timestamp_boundary", "image", "semantic_scope", "scale", "capabilities", "visibility"]
    .map(key => [key, value[key]]));
};
const output = value => Object.fromEntries(["width", "height", "bytes", "mimeType", "hash"].map(key => [key, value[key]]));
const native = await json(path.join(root, "native/run.json"));
for (const record of native.records) {
  assert.equal(hash(await readFile(path.join(root, `native/display-${record.scale}.png`))), record.output.hash);
}
const display = await json(path.join(root, "parent/fixed-display-summary.json"));
const window = await json(path.join(root, "parent/window.json"));
const browser = await json(path.join(root, "parent/browser-summary.json"));
const preview = await json(path.join(previewRoot, "run.json"));
const capture = preview.captures.find(frame => frame.hash === display.output.hash);
assert.ok(capture);
assert.deepEqual(capture.source.observation, display.source);
assert.equal(hash(await readFile(path.join(previewRoot, capture.filename))), display.output.hash);
assert.equal(hash(Buffer.from(window.image.data, "base64")), window.agent_image.output.hash);
const cleanup = await json(path.join(root, "cleanup.json"));
assert.equal(cleanup.DriverCount, 0);
assert.equal(cleanup.BrowserProfileEntries, 0);
assert.equal(cleanup.Notepad69472Present, false);
assert.equal(cleanup.Browser55248Present, false);
assert.equal(cleanup.Browser48704Present, false);
const report = {
  task: "LPT-376", privatePixelsExcluded: true,
  native: {
    calls: native.nativeCalls, policy: native.policy,
    safeBeforeCaptureCalls: native.safeBeforeCaptureCalls, revokedPixelsPublished: native.revokedPixelsPublished,
    records: native.records.map(record => ({ scale: record.scale, source: source(record.source), output: output(record.output) })),
  },
  parent: {
    display: { source: source(display.source), output: output(display.output), configuration: display.configuration },
    window: { source: source(window.source), output: output(window.agent_image.output), configuration: window.agent_image.configuration },
    browser: { source: source(browser.source), status: browser.status },
    preview: { revision: preview.revision, hash: capture.hash, exactBytesVerified: true, sourceGeometryPreserved: true, finalDelivery: "unconfirmed" },
    tui: { pane: "w3E9:p6", revision: 1462, inlineImages: "Stock collapsed output showed image indicators, not inline pixels." },
  },
  cleanup,
};
await mkdir(destination, { recursive: true });
await writeFile(path.join(destination, "run.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ destination, records: native.records.length, privatePixelsExcluded: true }));
