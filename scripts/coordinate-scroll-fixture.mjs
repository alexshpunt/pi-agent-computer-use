import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { loadComputerConfig } from "../src/config.ts";
import * as native from "../src/driver.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { nativePointerState } from "./native-pointer-state.mjs";
import { createCoordinateScrollSite } from "../test/fixtures/coordinate-scroll-site.mjs";

// Setup and witnesses only. All measured input must use ordinary IDE computer resources in Pi.
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.includes("--live-approved"), "Explicit disposable-window approval is required.");
const options = Object.fromEntries(arguments_.filter(value => value !== "--live-approved").map(value => {
  const match = /^--(target-position|sentinel-position|window-size)=(-?\d+),(-?\d+)$/.exec(value);
  assert.ok(match, `Unsupported setup argument: ${value}`);
  const pair = [Number(match[2]), Number(match[3])];
  assert.ok(pair.every(Number.isSafeInteger), "Setup bounds must be safe integers.");
  return [match[1], pair];
}));
assert.equal(Object.keys(options).length, arguments_.length - 1, "Do not repeat setup arguments.");
const size = options["window-size"] ?? [640, 800];
assert.ok(size[0] >= 500 && size[0] <= 3000 && size[1] >= 400 && size[1] <= 2000, "Use a visible disposable window size.");
const positions = [options["target-position"] ?? [60, 60], options["sentinel-position"] ?? [760, 60]];
const config = await loadComputerConfig(process.cwd()), driver = new native.McpDriver(config);
assert.equal(driver.coordinateScroll, true, "Select the byte-checked coordinate scroll candidate first.");
assert.equal(config.runtime, "windows-coordinate-scroll", "Do not use another candidate profile.");
const pin = native.COORDINATE_SCROLL_RUNTIME;
assert.ok(pin && /^[a-f0-9]{40}$/.test(pin.source) && /^[a-f0-9]{64}$/.test(pin.sha256) && pin.version,
  "The selected candidate needs exact source and artifact evidence.");
const directory = `.tmp/lpt-730/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const site = await createCoordinateScrollSite(), windows = [];
let serial = 0;
const record = async label => {
  const native_state = await nativePointerState(config.interop), state = site.state();
  await writeFile(`${directory}/${++serial}-${label}.json`, JSON.stringify({ label, state, native_state }, null, 2));
  console.log(JSON.stringify({ label, directory, native_state, reports: state.reports,
    event_counts: state.events.map(rows => rows.length), dropped: state.dropped }));
};
try {
  const root = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
  for (let index = 0; index < 2; index++) windows.push(await openCompleteInputWindow(driver, `${site.url}/${index}`, root,
    [`--window-size=${size.join(",")}`, `--window-position=${positions[index].join(",")}`]));
  for (let attempt = 0; attempt < 30 && !site.state().reports.every(Boolean); attempt++) await delay(100);
  assert.ok(site.state().reports.every(Boolean), "Both disposable pages must report readiness.");
  const fixture = { directory, url: site.url, runtime: config.runtime, candidate: pin,
    setup: { requested_size: size, requested_positions: positions, space: "setup_only_not_input_grounding" },
    windows: windows.map((window, index) => ({ ...window.target, title: `Pi coordinate scroll ${index ? "sentinel" : "target"}`, profile: window.profile })) };
  await writeFile(`${directory}/fixture.json`, JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
  await record("ready");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line.trim() === "finish") break;
    if (line.trim() === "state") await record("state");
    else if (/^mark [a-z0-9-]{1,50}$/.test(line.trim())) await record(line.trim().slice(5));
    else console.log("Commands: state, mark <lowercase-label>, finish");
  }
  input.close();
} finally {
  // Preserve witnesses before any cleanup input or task-owned process termination.
  const cleanup = [];
  try { await record("before-cleanup"); }
  catch (error) { cleanup.push({ operation: "save-witnesses", error: String(error) }); }
  for (const window of windows.reverse()) {
    try { cleanup.push({ target: window.target, result: await window.close() }); }
    catch (error) { cleanup.push({ target: window.target, error: String(error) }); }
  }
  for (const [operation, close] of [["driver-close", () => driver.close()], ["site-close", () => site.close()]]) {
    try { await close(); } catch (error) { cleanup.push({ operation, error: String(error) }); }
  }
  await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
  if (cleanup.some(row => row.error)) process.exitCode = 1;
}
