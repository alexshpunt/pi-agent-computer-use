import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

// Opt-in evidence export from this Pi session's private loopback viewer.
// Export only authorized frames to ignored storage; display pixels must never become public evidence. No new capture or input.
const [viewer, directory] = process.argv.slice(2);
const base = new URL(viewer);
assert.equal(base.hostname, "127.0.0.1");
assert.equal(base.protocol, "http:");
assert.match(base.pathname, /^\/[a-f0-9]{48}\/$/);
assert.ok(directory?.startsWith(".tmp/cua-pivot/") || directory?.startsWith(".tmp/native-zoom/") || directory?.startsWith(".tmp/region-highlights/") || directory?.startsWith(".tmp/cua-drag-fork/") || directory?.startsWith(".tmp/ui-resources/") || directory?.startsWith(".tmp/coordinate-annotations/"));
const response = await fetch(new URL("state", base));
assert.ok(response.ok, `Viewer state: ${response.status}`);
const state = await response.json();
await mkdir(directory, { recursive: true });
const captures = [];
for (const frame of state.captures) {
  assert.match(frame.hash, /^[a-f0-9]{64}$/);
  const asset = await fetch(new URL(`images/${frame.hash}`, base));
  assert.ok(asset.ok, `Retained image: ${asset.status}`);
  const bytes = Buffer.from(await asset.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), frame.hash);
  const extension = frame.mime === "image/jpeg" ? "jpg" : "png";
  assert.ok(["image/png", "image/jpeg"].includes(frame.mime));
  const filename = `${frame.id}.${extension}`;
  await writeFile(`${directory}/${filename}`, bytes);
  if (frame.original === "available" && frame.originalHash) {
    assert.match(frame.originalHash, /^[a-f0-9]{64}$/);
    const original = await fetch(new URL(`images/${frame.originalHash}`, base));
    assert.ok(original.ok, `Retained raw image: ${original.status}`);
    const raw = Buffer.from(await original.arrayBuffer());
    assert.equal(createHash("sha256").update(raw).digest("hex"), frame.originalHash);
    assert.equal(original.headers.get("content-type"), "image/png");
    frame.originalFilename = `${frame.id}-raw.png`;
    await writeFile(`${directory}/${frame.originalFilename}`, raw);
  }
  captures.push({ ...frame, filename });
}
await writeFile(`${directory}/run.json`, JSON.stringify({
  revision: state.revision, imageSettings: state.imageSettings,
  captures, actions: state.actions, limitations: state.limitations,
}, null, 2) + "\n");
console.log(JSON.stringify({ directory, revision: state.revision, captures: captures.length }));
