import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpDriver, KEY_HOLD_RUNTIME } from "../src/driver.ts";
import { ComputerSession } from "../src/session.ts";
import { loadComputerConfig } from "../src/config.ts";
import { openForkArtifact } from "./check-cua-fork-artifact.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { nativeInputState } from "./native-input-state.mjs";
import { createCompleteInputSite } from "../test/fixtures/complete-input-site.mjs";

// Opt-in native proof of the production hold adapter, only in a new disposable fixture.
assert.ok(process.argv.includes("--native"), "Pass --native to authorize a new local fixture.");
const artifactDirectory = resolve(process.argv[2]);
const directory = `.tmp/key-holds/adapter-${Date.now()}`;
await mkdir(directory, { recursive: true });
const installed = await loadComputerConfig(process.cwd());
const root = installed.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "").replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const peer = await openForkArtifact(artifactDirectory, KEY_HOLD_RUNTIME.source);
const command = process.argv.includes("--installed") ? installed.command : resolve(artifactDirectory, "runtime/cua-driver.exe");
const native = new McpDriver({ command, runtime: "windows-key-holds", interop: installed.interop ?? process.env.WSL_INTEROP });
const calls = [], records = [];
const driver = { heldPaths: native.heldPaths, heldKeys: native.heldKeys,
  identity: (...args) => native.identity(...args), close: () => native.close(),
  call: (name, args, signal) => { calls.push({ name, args }); return native.call(name, args, signal); } };
const session = new ComputerSession(driver), site = await createCompleteInputSite();
let fixture, success = false, cleanup;
function record(label, result) { records.push({ label, ...result.details }); return result; }
async function witness(predicate) {
  const end = Date.now() + 2000;
  while (Date.now() < end) { if (predicate(site.events())) return; await delay(20); }
  throw Error("Native hold witness missing; input was not replayed.");
}
function released(label) {
  const state = nativeInputState([16, 17, 18, 87, 91, 92]);
  records.push({ label, operation: "read_only_input_state", ...state });
  assert.ok(!state.left_down && !state.right_down && !state.middle_down && Object.values(state.keys).every(down => !down));
}
try {
  released("before-input");
  fixture = await openCompleteInputWindow(peer, site.url, root);
  await delay(4500); // Let the owned launch's asynchronous foreground restoration finish.
  const windows = record("discover", await session.windows());
  const matches = windows.details.state.windows.filter(w => w.pid === fixture.target.pid && w.window_id === fixture.target.window_id);
  assert.equal(matches.length, 1); const ref = matches[0].window_ref;
  async function observe(label) {
    const view = record(label, await session.observe(ref)); assert.equal(view.details.status, "observed");
    const png = view.content.find(block => block.type === "image"); assert.ok(png);
    const bytes = Buffer.from(png.data, "base64"); await writeFile(`${directory}/${label}.png`, bytes);
    records.at(-1).image = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    return view;
  }
  const hold = (view, fields = {}) => ({ window_ref: ref, observation_id: view.details.observation_id,
    action: "hold", keys: ["w", "shift"], duration_ms: 500, ...fields });
  let view = await observe("before-hold");
  const refused = record("background-refused", await session.act(hold(view)));
  assert.equal(refused.details.status, "refused"); assert.equal(site.events().filter(e => e.type === "keydown").length, 0);
  view = await observe("foreground-overview");
  const complete = record("w-shift", await session.act(hold(view, { delivery_mode: "foreground" })));
  assert.equal(complete.details.status, "delivered"); assert.match(complete.details.state.summary, /keys_released=true/);
  await witness(events => events.some(e => e.type === "keyup" && e.code === "KeyW")); released("timed-released");
  view = await observe("before-pointer");
  const boards = view.details.state.elements.filter(e => e.label === "Drawing board" && e.screenshot_frame);
  assert.equal(boards.length, 1); const r = boards[0].screenshot_frame;
  const points = Array.from({ length: 15 }, (_, i) => ({ x: r.x + r.w * (.15 + .7 * i / 14), y: r.y + r.h * (.5 + .28 * Math.sin(2 * Math.PI * i / 14)) }));
  const path = { action: "drag", from_x: points[0].x, from_y: points[0].y, via: points.slice(1, -1),
    to_x: points.at(-1).x, to_y: points.at(-1).y, duration_ms: 500 };
  const curve = record("shift-curve", await session.act(hold(view, { keys: ["shift"], duration_ms: 1000, actions: [path], delivery_mode: "foreground" })));
  assert.equal(curve.details.status, "delivered"); assert.match(curve.details.state.summary, /keys_released=true, pointer_actions=1\/1/);
  await witness(events => events.some(e => e.stroke === 1)); released("pointer-released");
  await observe("after-pointer");
  view = await observe("before-cancel"); const controller = new AbortController(), start = site.events().length;
  const request = hold(view, { keys: ["w"], duration_ms: 4000, delivery_mode: "foreground" });
  const pending = session.act(request, controller.signal);
  await witness(events => events.slice(start).some(e => e.type === "keydown" && e.code === "KeyW"));
  const started = Date.now(); controller.abort();
  const stopped = record("abort", await pending), elapsed_ms = Date.now() - started;
  assert.equal(stopped.details.status, "unknown"); assert.ok(elapsed_ms < 2000, "Owned EOF must stop before the four-second hold finishes.");
  records.push({ label: "abort-latency", elapsed_ms }); released("abort-released");
  assert.equal((await session.act(request)).details.status, "refused", "Cancelled overview cannot replay.");
  success = true;
} finally {
  try { cleanup = fixture ? await fixture.close() : undefined; }
  finally {
    await session.close(); await peer.close(); await site.close();
    await writeFile(`${directory}/run.json`, JSON.stringify({ success, runtime: KEY_HOLD_RUNTIME,
      calls, records, cleanup, events: site.events(), private_pixels: true }, null, 2));
  }
}
console.log(JSON.stringify({ success, directory, calls: calls.length, records: records.length }));
