import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openForkArtifact } from "./check-cua-fork-artifact.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { createCompleteInputSite } from "../test/fixtures/complete-input-site.mjs";
import { loadComputerConfig } from "../src/config.ts";

// Opt-in native input in new isolated local fixtures only. Never install or retry a path.
assert.ok(process.argv.includes("--native"), "Pass --native to authorize the disposable held-path fixtures.");
const artifactDirectory = process.argv[2], source = process.argv[3];
const directory = `.tmp/cua-drag-fork/native-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const root = config.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "").replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const site = await createCompleteInputSite(), otherSite = await createCompleteInputSite();
let active, peer, fixture, other, success = false, activeClosed = false;
const records = [], calls = [];
let installedApps;
const driver = { call: async (name, args) => {
  calls.push({ name, args, time: Date.now() });
  return active.call(name, args);
} };
const launcher = { call: async (name, args) => {
  // Reuse installed-app discovery, not dynamic entries for a running fixture.
  if (name === "list_apps" && installedApps) return installedApps;
  calls.push({ name, args, owner: "fixture_runtime", time: Date.now() });
  const result = await peer.call(name, args);
  if (name === "list_apps") installedApps = result;
  return result;
} };
const data = result => result.structuredContent;
const code = result => data(result)?.error?.code ?? data(result)?.code;
function receipt(label, result) {
  records.push({ label, data: data(result), isError: !!result.isError,
    text: result.content?.filter(block => block.type === "text").map(block => block.text),
    stderr: result.isError ? active?.diagnostics() : undefined });
  return result;
}
async function witness(predicate, label, milliseconds = 1500) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const events = site.events();
    if (predicate(events)) return events;
    await delay(20);
  }
  throw Error(`Native event witness missing: ${label}; no input was replayed.`);
}
function releasedButton(label) {
  // Read-only OS metadata, not an input/capture backend. After foreground loss
  // an app may lose capture and never receive pointerup; check physical release.
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class HeldPathMetadata { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key); }';
@{left_down=(([int][HeldPathMetadata]::GetAsyncKeyState(1) -band 32768) -ne 0)}|ConvertTo-Json -Compress`;
  const state = JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 15000, encoding: "utf8" }));
  records.push({ label, operation: "read_only_button_state", ...state });
  assert.equal(state.left_down, false, "Task-owned left button must be physically released.");
}
async function observe(label) {
  const result = receipt(label, await driver.call("get_window_state", { ...fixture.target, max_image_dimension: 500 }));
  assert.ok(!result.isError, JSON.stringify(data(result)));
  const png = result.content.find(block => block.type === "image" && block.mimeType === "image/png");
  assert.ok(png, "A real native PNG is required to ground the path.");
  const bytes = Buffer.from(png.data, "base64");
  await writeFile(`${directory}/${label}.png`, bytes);
  records.at(-1).image = { hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  return data(result);
}
function path(view, duration_ms = 800, count = 9) {
  const boards = view.elements.filter(element => element.label === "Drawing board" && element.screenshot_frame);
  assert.equal(boards.length, 1, "Require one native Drawing board frame.");
  const r = boards[0].screenshot_frame;
  const points = Array.from({ length: count }, (_, i) => ({ x: r.x + r.w * (0.15 + 0.7 * i / (count - 1)), y: r.y + r.h * (0.5 + 0.28 * Math.sin(2 * Math.PI * i / (count - 1))) }));
  return { ...fixture.target, from_x: points[0].x, from_y: points[0].y,
    via: points.slice(1, -1), to_x: points.at(-1).x, to_y: points.at(-1).y,
    duration_ms, delivery_mode: "foreground" };
}
try {
  active = await openForkArtifact(artifactDirectory, source);
  assert.equal(active.report.has_drag_via, true, "Only a candidate advertising via may run this probe.");
  // Keep launch ownership outside the transport whose EOF is under test.
  peer = await openForkArtifact(artifactDirectory, source);
  fixture = await openCompleteInputWindow(launcher, site.url, root);
  // Upstream launch_app owns a <=1s idle wait plus <=3s asynchronous
  // foreground restore. Do not make this probe's explicit gesture race it.
  // This is bounded fixture setup, not a promise that app pixels are ready.
  await delay(4500);
  let view = await observe("initial");
  for (let n = 0; n < 8 && !view.elements.some(element => element.label === "Drawing board" && element.screenshot_frame); n++) {
    await delay(300); view = await observe(`initial-read-${n}`);
  }
  const curve = path(view);
  const before = site.events().length;
  const background = receipt("background-refused", await driver.call("drag", { ...curve, delivery_mode: "background" }));
  assert.equal(code(background), "background_unavailable");
  const conflict = receipt("conflicting-fields-refused", await driver.call("drag", { ...curve, steps: 20 }));
  assert.equal(code(conflict), "conflicting_path_fields");
  const outside = receipt("outside-refused", await driver.call("drag", { ...curve, to_x: 1000000 }));
  assert.equal(code(outside), "path_point_outside_window");
  assert.equal(site.events().slice(before).filter(event => event.type === "pointerdown").length, 0);
  view = await observe("before-curve");
  const complete = receipt("curve", await driver.call("drag", path(view)));
  assert.ok(!complete.isError, JSON.stringify(records.at(-1)));
  assert.equal(data(complete).effect, "unverifiable");
  assert.equal(data(complete).delivery.delivered_count, 9);
  assert.match(data(complete).summary, /pressed=true, released=true/);
  await observe("after-curve");
  const events = await witness(events => events.some(event => event.stroke === 1), "one complete curve");
  assert.equal(events.filter(event => event.type === "pointerdown" && event.target === "board").length, 1);
  assert.equal(events.filter(event => event.stroke).length, 1);
  const moves = events.filter(event => event.type === "pointermove" && event.target === "board");
  assert.ok(moves.length >= 5 && moves.every(event => event.buttons === 1 && event.pointerType === "mouse"));
  assert.ok(Math.max(...moves.map(event => event.y)) - Math.min(...moves.map(event => event.y)) > 20, "Curve must not collapse to a straight segment.");

  // Another owned CUA peer requests a foreground change during the held path.
  // This tests interruption without another input backend.
  other = await openCompleteInputWindow(launcher, otherSite.url, root);
  await delay(4500); // Same bounded launch-only restore window for the second fixture.
  view = await observe("before-foreground-loss");
  const interrupted = driver.call("drag", path(view, 4000, 40)).then(result => ({ result }), error => ({ error }));
  await witness(events => events.filter(event => event.type === "pointerdown" && event.target === "board").length === 2, "held path before foreground change");
  const focused = receipt("owned-foreground-change", await peer.call("bring_to_front", other.target));
  assert.notEqual(data(focused)?.actual_foreground_window_id, fixture.target.window_id,
    "The focus-change attempt must leave the primary target.");
  const interruption = await interrupted;
  if (interruption.error) throw interruption.error;
  const stopped = receipt("foreground-loss", interruption.result);
  assert.equal(data(stopped).effect, "partial", JSON.stringify(records.at(-1)));
  assert.ok(data(stopped).delivery.delivered_count > 0 && data(stopped).delivery.delivered_count < 40);
  assert.match(data(stopped).summary, /released=true.*foreground_lost/);
  releasedButton("foreground-loss-physical-release");

  view = await observe("before-eof-cancel");
  const pending = driver.call("drag", path(view, 4000, 40)).then(result => ({ result }), error => ({ error: error.name }));
  await witness(events => events.filter(event => event.type === "pointerdown" && event.target === "board").length === 3, "held path before EOF");
  const cancelStart = Date.now();
  try { await active.close(); } finally { activeClosed = true; }
  const cancelled = await pending;
  releasedButton("eof-physical-release");
  const elapsed = Date.now() - cancelStart;
  records.push({ label: "eof-cancel", elapsed_ms: elapsed, pending: cancelled,
    moves: site.events().filter(event => event.type === "pointermove").length });
  assert.ok(elapsed < 2000, "EOF and confirmed release must finish before the full four-second path.");
  active = await openForkArtifact(artifactDirectory, source); activeClosed = false;
  await observe("after-eof");
  success = true;
} finally {
  // Each close uses a new observation of only its own disposable window.
  let cleanup;
  try {
    if (activeClosed && (fixture || other)) { active = await openForkArtifact(artifactDirectory, source); activeClosed = false; }
    if (active) {
      const secondary = other ? await other.close() : undefined;
      const primary = fixture ? await fixture.close() : undefined;
      cleanup = { primary, secondary };
    }
  } finally {
    await peer?.close(); await active?.close(); await site.close(); await otherSite.close();
    await writeFile(`${directory}/run.json`, JSON.stringify({ success, source, calls, records, events: site.events(), otherEvents: otherSite.events(), cleanup, private_pixels: true }, null, 2));
  }
}
console.log(JSON.stringify({ success, directory, calls: calls.length, records: records.length }));
