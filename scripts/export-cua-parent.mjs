import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Offline export of actual parent tool results and the exact retained debug bytes.
// Input comes from a completed synthetic run; this script starts no browser or capture.
const directory = process.argv[2];
assert.ok(directory?.startsWith(".tmp/cua-pivot/"));
const root = "docs/evidence/cua-browser";
await mkdir(root, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const input = JSON.parse(await readFile(path.join(directory, "tool-results.json"), "utf8"));
const rows = [];
for (const { step, view } of input.rows) {
  assert.match(step, /^[a-z]+$/);
  assert.equal(view.status, "observed");
  assert.ok(["image/png", "image/jpeg"].includes(view.image.mimeType));
  const bytes = Buffer.from(view.image.data, "base64");
  assert.equal(hash(bytes), view.agent_image.output.hash);
  assert.equal(bytes.length, view.agent_image.output.bytes);
  const filename = `parent-foreground-${step}.${view.image.mimeType === "image/png" ? "png" : "jpg"}`;
  await writeFile(path.join(root, filename), bytes);
  const { image: _image, ...metadata } = view;
  rows.push({ step, ...metadata, image: { filename, bytes: bytes.length, sha256: hash(bytes) } });
}
const previewDirectory = path.join(directory, "updated-controls");
const preview = JSON.parse(await readFile(path.join(previewDirectory, "run.json"), "utf8"));
const controls = [];
for (const [index, frame] of preview.captures.entries()) {
  assert.match(frame.filename, /^frame-[0-9]+\.png$/);
  const bytes = await readFile(path.join(previewDirectory, frame.filename));
  assert.equal(hash(bytes), frame.hash);
  assert.equal(bytes.length, frame.bytes);
  const filename = `parent-controls-${index}.png`;
  await copyFile(path.join(previewDirectory, frame.filename), path.join(root, filename));
  controls.push({ ...frame, filename });
}
assert.deepEqual(controls.map(frame => frame.configuration.effective.configuration.scale), [1, 0.5, 1]);
assert.deepEqual(controls.map(frame => frame.width), [500, 249, 500]);
await writeFile(path.join(root, "parent-foreground.json"), JSON.stringify({
  source: input.source, rows, controls,
  tui: [input.tui, { pane: "w3E9:p6", revision: 1036,
    judgment: "Readable native input children, scale and foreground metadata. Stock collapsed output hides inline pixels." }],
  cleanup: { ownedBrowserPidsPresent: 0, newDriverCount: 0, profileEntries: 0,
    fixtureStopped: true, verifiedBy: "Read-only Get-Process and owned fixture terminal exit0 after close." },
  limits: preview.limitations,
}, null, 2) + "\n");
console.log(JSON.stringify({ rows: rows.length, controls: controls.length, directory: root }));
