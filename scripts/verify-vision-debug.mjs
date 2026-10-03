import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Read-only parent viewer check. Only local debug data and this session's recorded image results.
const [address, sessionFile, destination = ".tmp/vision-parent"] = process.argv.slice(2);
const url = new URL(address);
assert.equal(url.hostname, "127.0.0.1");
assert.equal(url.protocol, "http:");
const stateResponse = await fetch(new URL("state", url));
assert.equal(stateResponse.status, 200);
const state = await stateResponse.json();
const entries = (await readFile(sessionFile, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
const forwarded = new Map();
for (const entry of entries) {
  const message = entry.message;
  if (message?.role !== "toolResult") continue;
  for (const block of message.content ?? []) {
    if (block.type !== "image" || typeof block.data !== "string") continue;
    const bytes = Buffer.from(block.data, "base64");
    forwarded.set(createHash("sha256").update(bytes).digest("hex"), bytes);
  }
}
assert.ok(state.frames.length > 0 && state.frames.length <= 3);
assert.ok(state.actions.some(action => action.isError), "Refusal missing from the trace.");
assert.ok(state.captures.length > 0);
await mkdir(destination, { recursive: true });
let matched = 0;
for (const [index, frame] of state.frames.entries()) {
  assert.equal(frame.finalDelivery, "unconfirmed");
  assert.equal(frame.original, "unavailable");
  assert.notEqual(frame.stage, "sent");
  const response = await fetch(new URL("images/" + frame.hash, url));
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), frame.hash);
  if (forwarded.has(frame.hash)) { assert.deepEqual(bytes, forwarded.get(frame.hash)); matched++; }
  await writeFile(path.join(destination, "boundary-" + index + ".png"), bytes);
}
assert.ok(matched > 0, "No retained boundary image matched an actual forwarded Pi tool-result image.");
const times = [];
for (let index = 0; index < 20; index++) {
  const started = performance.now();
  const response = await fetch(new URL("state", url));
  assert.equal(response.status, 200); await response.arrayBuffer();
  times.push(performance.now() - started);
}
times.sort((a, b) => a - b);
const summary = { sessionId: state.sessionId, frames: state.frames.length, requests: state.requests.length,
  actions: state.actions.map(({ id, parentId, tool, status, isError, durationMs }) => ({ id, parentId, tool, status, isError, durationMs })),
  matchingForwardedFrames: matched, finalDelivery: "unconfirmed",
  viewerFetch: { samples: times.length, p50_ms: times[9], p95_ms: times[18], note: "Local state fetch only, not capture/model/UI latency." } };
await writeFile(path.join(destination, "state.json"), JSON.stringify(state, null, 2));
await writeFile(path.join(destination, "run.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
