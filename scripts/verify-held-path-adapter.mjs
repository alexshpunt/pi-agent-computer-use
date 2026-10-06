import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpDriver, HELD_PATH_RUNTIME } from "../src/driver.ts";
import { ComputerSession } from "../src/session.ts";
import { loadComputerConfig } from "../src/config.ts";
import { openForkArtifact } from "./check-cua-fork-artifact.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { createCompleteInputSite } from "../test/fixtures/complete-input-site.mjs";

// Opt-in isolated native proof of the production adapter and AbortSignal -> owned EOF cleanup.
assert.ok(process.argv.includes("--native"), "Pass --native to authorize a NEW disposable local fixture.");
const artifactDirectory = resolve(process.argv[2]);
const directory = `.tmp/cua-drag-fork/adapter-${Date.now()}`;
await mkdir(directory, { recursive: true });
const installed = await loadComputerConfig(process.cwd());
const root = installed.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "").replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const peer = await openForkArtifact(artifactDirectory, HELD_PATH_RUNTIME.source);
const command = process.argv.includes("--installed") ? installed.command : resolve(artifactDirectory, "runtime/cua-driver.exe");
const native = new McpDriver({ command, runtime: "windows-held-paths", interop: installed.interop ?? process.env.WSL_INTEROP });
const calls = [], records = [];
const driver = { heldPaths: native.heldPaths, identity: (...args) => native.identity(...args), close: () => native.close(),
  call: async (name, args, signal) => { calls.push({ name, args }); return native.call(name, args, signal); } };
const session = new ComputerSession(driver);
const site = await createCompleteInputSite();
let fixture, success = false, cleanup;
function record(label, result) { records.push({ label, ...result.details }); return result; }
async function witness(predicate) {
  const end = Date.now() + 1500;
  while (Date.now() < end) { if (predicate(site.events())) return; await delay(20); }
  throw Error("Native event witness missing; no input was replayed.");
}
try {
  fixture = await openCompleteInputWindow(peer, site.url, root);
  await delay(4500); // Let the upstream own-launch foreground restoration finish.
  const windows = record("discover", await session.windows());
  const matches = windows.details.state.windows.filter(w => w.pid === fixture.target.pid && w.window_id === fixture.target.window_id);
  assert.equal(matches.length, 1); const ref = matches[0].window_ref;
  const observe = async label => {
    const view = record(label, await session.observe(ref)); assert.equal(view.details.status, "observed");
    const png = view.content.find(block => block.type === "image"); assert.ok(png);
    const bytes = Buffer.from(png.data, "base64"); await writeFile(`${directory}/${label}.png`, bytes);
    records.at(-1).image = { hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    return view;
  };
  let view = await observe("before-curve");
  const path = view => {
    const boards = view.details.state.elements.filter(e => e.label === "Drawing board" && e.screenshot_frame);
    assert.equal(boards.length, 1); const r = boards[0].screenshot_frame;
    const points = Array.from({ length: 25 }, (_, i) => ({ x: r.x + r.w * (0.15 + 0.7 * i / 24), y: r.y + r.h * (0.5 + 0.28 * Math.sin(2 * Math.PI * i / 24)) }));
    return { window_ref: ref, observation_id: view.details.observation_id, action: "drag", from_x: points[0].x, from_y: points[0].y,
      via: points.slice(1, -1), to_x: points.at(-1).x, to_y: points.at(-1).y, duration_ms: 800 };
  };
  const refused = record("background-refused", await session.act(path(view)));
  assert.equal(refused.details.status, "refused"); assert.equal(site.events().filter(e => e.type === "pointerdown").length, 0);
  view = await observe("foreground-overview");
  const curve = record("curve", await session.act({ ...path(view), delivery_mode: "foreground" }));
  assert.equal(curve.details.status, "delivered"); assert.equal(curve.details.state.delivery.delivered_count, 25);
  await witness(events => events.filter(e => e.type === "pointerup" && e.target === "board").length === 1);
  await observe("after-curve");
  view = await observe("before-cancel"); const controller = new AbortController();
  const pending = session.act({ ...path(view), duration_ms: 4000, delivery_mode: "foreground" }, controller.signal);
  await witness(events => events.filter(e => e.type === "pointerdown" && e.target === "board").length === 2);
  const started = Date.now(); controller.abort();
  const stopped = record("abort", await pending); const elapsed = Date.now() - started;
  assert.equal(stopped.details.status, "unknown"); assert.ok(elapsed < 2000, "Adapter EOF must release before full path completion.");
  const script = String.raw`Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class AdapterButtonMetadata { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); }'; @{left_down=(([int][AdapterButtonMetadata]::GetAsyncKeyState(1) -band 32768) -ne 0)}|ConvertTo-Json -Compress`;
  const state = JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", ["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")], { encoding: "utf8", timeout: 15000 }));
  records.push({ label: "physical-release", operation: "read_only_button_state", elapsed_ms: elapsed, ...state });
  assert.equal(state.left_down, false);
  assert.equal((await session.act(path(view))).details.status, "refused", "Cancelled overview cannot replay");
  success = true;
} finally {
  try { cleanup = fixture ? await fixture.close() : undefined; }
  finally { await session.close(); await peer.close(); await site.close();
    await writeFile(`${directory}/run.json`, JSON.stringify({ success, runtime: HELD_PATH_RUNTIME, calls, records, cleanup, events: site.events(), private_pixels: true }, null, 2)); }
}
console.log(JSON.stringify({ success, directory, calls: calls.length, records: records.length }));
