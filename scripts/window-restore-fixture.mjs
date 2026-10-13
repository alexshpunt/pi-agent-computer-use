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

// Setup and independent readonly witnesses only. Restore is performed by ordinary IDE Read/Insert.
assert.ok(process.argv.includes("--live-approved"), "Explicit disposable-window approval is required.");
const acceptedOptions = ["--live-approved", "--target-position=", "--sentinel-position=", "--window-size="];
assert.ok(process.argv.slice(2).every(arg => acceptedOptions.some(option => option.endsWith("=") ? arg.startsWith(option) : arg === option)), "Unsupported fixture option.");
function pair(name, fallback, dimensions = false) {
  const found = process.argv.slice(2).filter(arg => arg.startsWith(`${name}=`));
  assert.ok(found.length <= 1, `Duplicate ${name}.`);
  const value = found[0]?.slice(name.length + 1) ?? fallback;
  assert.match(value, dimensions ? /^\d+,\d+$/ : /^-?\d+,-?\d+$/, `Invalid ${name}.`);
  const values = value.split(",").map(Number);
  assert.ok(values.every(number => Number.isSafeInteger(number) && (dimensions ? number >= 200 && number <= 4096 : Math.abs(number) <= 100000)), `Out-of-range ${name}.`);
  return values.join(",");
}
const positions = [pair("--target-position", "60,60"), pair("--sentinel-position", "760,60")];
const size = pair("--window-size", "640,800", true);
const config = await loadComputerConfig(process.cwd()), driver = new driverModule.McpDriver(config);
assert.equal(driver.platform, "windows", "This fixture is for the approved Windows host only.");
assert.equal(driver.windowLifetime, true, "Native Windows lifetime support is required.");
assert.equal(config.runtime, "windows-window-restore", "Select only the isolated window-restore candidate.");
assert.equal(driver.windowRestore, true, "The selected runtime must supply exact state-bound restoration.");
assert.ok(config.command.startsWith("/mnt/c/"), "Use the selected Windows runtime from WSL; this helper installs nothing.");
const candidate = driverModule.WINDOW_RESTORE_RUNTIME;
assert.ok(candidate && /^[0-9a-f]{40}$/.test(candidate.source) && /^[0-9a-f]{64}$/.test(candidate.sha256) && typeof candidate.version === "string",
  "The window-restore artifact must have an actual qualified pin, not a placeholder.");
const actualHash = createHash("sha256").update(await readFile(config.command)).digest("hex");
assert.equal(actualHash, candidate.sha256, "Selected candidate bytes differ from the pinned artifact.");
const nativeRoot = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const directory = `.tmp/lpt-703/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const site = await createIdeProviderSite(), windows = [];
let serial = 0, stopping = false, input;
const stop = () => { stopping = true; input?.close(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const record = async label => {
  const native_state = windows.length ? await nativeWindowState(config.interop, windows.map(window => window.target)) : null;
  const state = site.state();
  await writeFile(`${directory}/${++serial}-${label}.json`, JSON.stringify({ label, native_state, state }, null, 2));
  console.log(JSON.stringify({ label, directory, native_state, measured_ms: state.measured_ms, reports: state.reports,
    event_counts: state.events.map(rows => rows.length), dropped: state.dropped, rejected: state.rejected }));
  return { native_state, state };
};
try {
  for (let index = 0; index < 2 && !stopping; index++) {
    // Only the target's native CUA launch requests minimization. No keys, clicks or shell window mutation.
    const setupDriver = index === 0 ? { call: (name, args) => driver.call(name, name === "launch_app" ? { ...args, start_minimized: true } : args) } : driver;
    windows.push(await openCompleteInputWindow(setupDriver, `${site.url}/${index}`, nativeRoot,
      [`--window-size=${size}`, `--window-position=${positions[index]}`]));
  }
  if (!stopping) {
    for (let attempt = 0; attempt < 100 && !site.state().reports.every(report => report?.fresh) && !stopping; attempt++) await delay(100);
    const { native_state, state } = await record("setup-check");
    assert.ok(native_state?.status === "measured" && native_state.windows.every(window => window.exists), "Both exact fixture windows need independently measured ownership.");
    assert.equal(native_state.windows[0].minimized, true, "CUA setup must leave only the target minimized.");
    assert.equal(native_state.windows[0].foreground_at_target, false, "The minimized target must not already be foreground.");
    assert.equal(native_state.windows[1].minimized, false, "The sentinel must remain unminimized.");
    assert.ok(state.reports.every(report => report?.fresh), "Both pages must supply fresh readiness reports; minimized timers may throttle, but stale state is not acceptance.");
    assert.ok(state.reports.every(report => report.value === "" && report.count === 0 && Object.values(report.counts).every(count => count === 0)) &&
      state.events.every(rows => rows.length === 0) && state.dropped.every(count => count === 0) && state.rejected.every(count => count === 0),
      "Setup must leave zero document input events in both windows.");
    const fixture = { directory, url: site.url, runtime: config.runtime, command: config.command,
      candidate: { source: candidate.source, version: candidate.version, sha256: actualHash },
      windows: windows.map((window, index) => ({ ...window.target, title: `Pi IDE computer ${index ? "sentinel" : "target"}`,
        role: index ? "sentinel" : "minimized-target", profile: window.profile })),
      measured_input: "Only ordinary IDE Read state/Insert restore. This helper never restores, activates, renews state admission or performs measured input.",
      witness: "Read-only Win32 ownership/minimized/visible/foreground/focus/pointer metadata, plus independent browser journals. Metadata coordinates never become input targets." };
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
  // Preserve the last measured journals before owned browser cleanup or termination.
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
