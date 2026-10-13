import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { loadComputerConfig } from "../src/config.ts";
import * as driverModule from "../src/driver.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { createIdeProviderSite } from "../test/fixtures/ide-provider-site.mjs";
import { nativeWindowState } from "./native-window-state.mjs";

// Setup and independent readonly witnesses only. All measured management uses ordinary IDE Read/Insert.
const args = process.argv.slice(2);
assert.equal(args.filter(arg => arg === "--live-approved").length, 1, "Explicit disposable-window approval is required once.");
const acceptedOptions = ["--live-approved", "--target-position=", "--sentinel-position=", "--window-size="];
assert.ok(args.every(arg => acceptedOptions.some(option => option.endsWith("=") ? arg.startsWith(option) : arg === option)), "Unsupported fixture option.");
function pair(name, fallback, dimensions = false) {
  const found = args.filter(arg => arg.startsWith(`${name}=`));
  assert.ok(found.length <= 1, `Duplicate ${name}.`);
  const value = found[0]?.slice(name.length + 1) ?? fallback;
  assert.match(value, dimensions ? /^\d+,\d+$/ : /^-?\d+,-?\d+$/, `Invalid ${name}.`);
  const values = value.split(",").map(Number);
  assert.ok(values.every(number => Number.isSafeInteger(number) && (dimensions ? number >= 200 && number <= 4096 : Math.abs(number) <= 100000)), `Out-of-range ${name}.`);
  return values.join(",");
}
function hasGeometry(window) {
  const bounds = window.bounds;
  return bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) &&
    bounds.width > 0 && bounds.height > 0 && typeof window.maximized === "boolean" &&
    Number.isSafeInteger(window.dpi) && window.dpi > 0;
}
function histograms(events) {
  return events.map(rows => {
    const counts = {};
    for (const event of rows) {
      const type = counts[event.type] ??= { trusted: 0, untrusted: 0 };
      type[event.trusted ? "trusted" : "untrusted"]++;
    }
    return counts;
  });
}
const positions = [pair("--target-position", "60,60"), pair("--sentinel-position", "760,60")];
const size = pair("--window-size", "640,800", true);
const config = await loadComputerConfig(process.cwd()), driver = new driverModule.McpDriver(config);
assert.equal(driver.platform, "windows", "This fixture is for the approved Windows host only.");
assert.equal(driver.windowLifetime, true, "Native Windows lifetime support is required.");
assert.equal(config.runtime, "windows-window-management", "Select only the isolated window-management candidate.");
assert.equal(driver.windowManagement, true, "The selected runtime must supply exact state-bound window management.");
assert.ok(config.command.startsWith("/mnt/c/"), "Use the selected Windows runtime from WSL; this helper installs nothing.");
const candidate = driverModule.WINDOW_MANAGEMENT_RUNTIME;
assert.ok(candidate && /^[0-9a-f]{40}$/.test(candidate.source) && /^[0-9a-f]{64}$/.test(candidate.sha256) && typeof candidate.version === "string",
  "The window-management artifact must have an actual qualified pin, not a placeholder.");
const actualHash = createHash("sha256").update(await readFile(config.command)).digest("hex");
assert.equal(actualHash, candidate.sha256, "Selected candidate bytes differ from the pinned artifact.");
const nativeRoot = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const directory = `.tmp/lpt-731/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const site = await createIdeProviderSite(), windows = [];
let serial = 0, stopping = false, input;
const stop = () => { stopping = true; input?.close(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const record = async label => {
  const native_state = windows.length ? await nativeWindowState(config.interop, windows.map(window => window.target)) : null;
  const state = site.state(), event_histograms = histograms(state.events);
  await writeFile(`${directory}/${++serial}-${label}.json`, JSON.stringify({ label, native_state, state, event_histograms }, null, 2));
  console.log(JSON.stringify({ label, directory, native_state, measured_ms: state.measured_ms, reports: state.reports,
    event_counts: state.events.map(rows => rows.length), event_histograms, dropped: state.dropped, rejected: state.rejected }));
  return { native_state, state };
};
try {
  for (let index = 0; index < 2 && !stopping; index++) {
    // Normal CUA-owned launches only: no minimization, restore, focus or geometry mutation after launch.
    windows.push(await openCompleteInputWindow(driver, `${site.url}/${index}`, nativeRoot,
      [`--window-size=${size}`, `--window-position=${positions[index]}`]));
  }
  if (!stopping) {
    for (let attempt = 0; attempt < 100 && !site.state().reports.every(report => report?.fresh) && !stopping; attempt++) await delay(100);
    const { native_state, state } = await record("setup-check");
    assert.ok(native_state?.status === "measured" && native_state.windows.length === 2 &&
      native_state.windows.every(window => window.exists), "Both exact fixture windows need independently measured ownership.");
    assert.ok(native_state.windows.every(window => window.minimized === false && window.visible === true && window.maximized === false),
      "CUA setup must leave both windows visible, unminimized and unmaximized.");
    assert.ok(native_state.windows.every(hasGeometry), "Bounds, maximized state and DPI must be independently measured; missing geometry is not a passing setup.");
    assert.ok(state.reports.every(report => report?.fresh), "Both pages must supply fresh readiness reports; stale state is not acceptance.");
    assert.ok(state.reports.every(report => report.value === "" && report.count === 0 && Object.values(report.counts).every(count => count === 0)) &&
      state.events.every(rows => rows.length === 0) && state.dropped.every(count => count === 0) && state.rejected.every(count => count === 0),
      "Setup must leave zero document input events in both windows.");
    const fixture = { directory, url: site.url, runtime: config.runtime, command: config.command,
      candidate: { source: candidate.source, version: candidate.version, sha256: actualHash },
      windows: windows.map((window, index) => ({ ...window.target, title: `Pi IDE computer ${index ? "sentinel" : "target"}`,
        role: index ? "sentinel" : "management-target", profile: window.profile })),
      measured_input: "Only ordinary IDE Read and one explicit Insert per fresh state. This helper never manages a window, renews state admission or performs measured input.",
      witness: "Independent readonly Win32 ownership, separate GetWindowRect outer bounds and DWM visible-frame bounds, maximized/minimized/visible state, DPI, foreground/focus/pointer and complete browser journals with histograms. Compare each declared bounds source with its matching witness rectangle; metadata coordinates never become input targets." };
    await writeFile(`${directory}/fixture.json`, JSON.stringify(fixture, null, 2));
    console.log(JSON.stringify(fixture));
    await record("ready");
    if (!stopping) {
      input = createInterface({ input: process.stdin });
      for await (const line of input) {
        if (line.trim() === "finish" || stopping) break;
        if (line.trim() === "state") await record("state");
        else if (/^mark [a-z0-9-]{1,50}$/.test(line.trim())) await record(line.trim().slice(5));
        else console.log("Commands: state, mark <lowercase-label>, finish");
      }
      input.close();
    }
  }
} finally {
  input?.close();
  const cleanup = [];
  // Save the final measured journals before cleanup; the shared owned-window helper may close/terminate only now.
  try { await record("before-cleanup"); }
  catch (error) { cleanup.push({ witness_error: String(error) }); }
  for (const window of windows.reverse()) {
    try { cleanup.push({ target: window.target, result: await window.close() }); }
    catch (error) { cleanup.push({ target: window.target, error: String(error) }); }
  }
  const released = await Promise.allSettled([driver.close(), site.close()]);
  for (const [index, result] of released.entries()) if (result.status === "rejected") cleanup.push({ release: index ? "site" : "driver", error: String(result.reason) });
  await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  if (cleanup.some(row => row.error || row.witness_error || row.release)) process.exitCode = 1;
}
