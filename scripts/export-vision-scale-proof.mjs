import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Export a completed on-page trial, not a reading/answering shortcut. No expected text is fetched.
const [viewerUrl, framePath, directory = ".tmp/vision-scale/parent"] = process.argv.slice(2);
const viewer = new URL(viewerUrl);
if (viewer.protocol !== "http:" || viewer.hostname !== "127.0.0.1" || !/^\/[a-f0-9]{48}\/$/.test(viewer.pathname) || viewer.username || viewer.password)
  throw new Error("Expected this session's loopback viewer URL.");
const frame = JSON.parse(await readFile(framePath, "utf8"));
assert.match(frame.trial, /^[a-f0-9]{32}$/);
assert.equal(frame.answers.length, 12);
const resultsResponse = await fetch(new URL("trial/results", viewer));
assert.equal(resultsResponse.status, 200);
const results = await resultsResponse.json();
const grade = results.find(result => result.trial === frame.trial);
assert.ok(grade, "Enter and grade this trial in the form before exporting any source pixels.");
assert.equal(grade.rows.length, 12);
assert.ok(grade.rows.every(row => ["correct", "wrong"].includes(row.status)));
assert.deepEqual(grade.configuration, frame.image.configuration);
const state = await (await fetch(new URL("state", viewer))).json();
const matches = state.frames.filter(item => item.hash === frame.image.output.hash).map(item => ({
  id: item.id, requestId: item.requestId, hash: item.hash, stage: item.stage, width: item.width, height: item.height,
  configuration: item.configuration, finalDelivery: item.finalDelivery, original: item.original, originalHash: item.originalHash,
}));
assert.ok(matches.length, "No application-boundary image with the submitted frame hash.");
await mkdir(directory, { recursive: true });
const assets = [];
const requested = [["agent", frame.image.output], ["original", frame.image.source]];
if (frame.after) requested.push(["after-agent", frame.after.image.output]); // Never fetch the ungraded next trial's original.
for (const [name, expected] of requested) {
  assert.match(expected.hash, /^[a-f0-9]{64}$/);
  const response = await fetch(new URL("images/" + expected.hash, viewer));
  assert.equal(response.status, 200, "Actual retained " + name + " image unavailable.");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.hash);
  assert.equal(bytes.readUInt32BE(16), expected.width); assert.equal(bytes.readUInt32BE(20), expected.height);
  assert.equal(bytes.length, expected.bytes);
  await writeFile(path.join(directory, name + ".png"), bytes);
  assets.push({ name, hash: expected.hash, width: expected.width, height: expected.height, bytes: bytes.length });
}
const requestIds = new Set(matches.map(item => item.requestId));
const models = state.requests.filter(item => requestIds.has(item.id)).map(item => ({ provider: item.provider, api: item.api, model: item.model }));
const proof = { trial: frame.trial, submitted: frame, grade, assets, boundaryFrames: matches, models,
  boundary: "Existing Pi application hook; final delivery and provider preprocessing unconfirmed.",
  method: "Twelve transcriptions entered and graded in the actual form before exporting the full-resolution source." };
await writeFile(path.join(directory, "run.json"), JSON.stringify(proof, null, 2) + "\n");
console.log(JSON.stringify({ directory, trial: frame.trial, correct: grade.rows.filter(row => row.status === "correct").length, assets, boundaryMatches: matches.length }));
