import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { createIdeProviderSite } from "../test/fixtures/ide-provider-site.mjs";

// Setup and readonly witnesses only. Parent performs measured input through ordinary IDE tools.
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
const config = await loadComputerConfig(process.cwd()), driver = new McpDriver(config);
assert.equal(driver.platform, "windows", "This fixture is for the approved Windows host only.");
assert.equal(driver.windowLifetime, true, "Native Windows lifetime support is required.");
assert.ok(!["windows-native-pointer", "windows-coordinate-scroll"].includes(config.runtime), "Keep the existing runtime; this fixture does not qualify hover or scroll candidates.");
assert.ok(config.command.startsWith("/mnt/c/"), "Use the selected Windows runtime from WSL; this helper does not install or select a runtime.");
const nativeRoot = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const directory = `.tmp/lpt-750/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const site = await createIdeProviderSite(), windows = [];
let serial = 0, stopping = false, input;
const stop = () => { stopping = true; input?.close(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const record = async label => {
  const state = site.state();
  await writeFile(`${directory}/${++serial}-${label}.json`, JSON.stringify({ label, state }, null, 2));
  console.log(JSON.stringify({ label, directory, measured_ms: state.measured_ms, reports: state.reports,
    event_counts: state.events.map(rows => rows.length), dropped: state.dropped, rejected: state.rejected }));
};
try {
  for (let index = 0; index < 2 && !stopping; index++) windows.push(await openCompleteInputWindow(driver, `${site.url}/${index}`, nativeRoot,
    [`--window-size=${size}`, `--window-position=${positions[index]}`]));
  if (!stopping) {
    for (let attempt = 0; attempt < 50 && !site.state().reports.every(report => report?.fresh) && !stopping; attempt++) await delay(100);
    const state = site.state();
    assert.ok(stopping || state.reports.every(report => report?.fresh), "Both disposable pages must send fresh readiness reports.");
    assert.ok(stopping || state.reports.every(report => report.value === "" && report.count === 0) &&
      state.events.every(rows => rows.length === 0) && state.dropped.every(count => count === 0) && state.rejected.every(count => count === 0),
      "Setup must leave both fixture pages empty with no document input journal.");
    const fixture = { directory, url: site.url, runtime: config.runtime ?? "bundled-or-trusted-command", command: config.command,
      ...(config.bundled ? { bundle: { source: config.bundled.source, version: config.bundled.version,
        driver_version: config.bundled.driverVersion, target: config.bundled.target } } : {}),
      windows: windows.map((window, index) => ({ ...window.target, title: `Pi IDE computer ${index ? "sentinel" : "target"}`, profile: window.profile })),
      measured_input: "Ordinary IDE Read/Search/Write/Insert only; this helper performs setup, witnesses and owned cleanup." };
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
  // Preserve acceptance witnesses before cleanup clicks or owned-process termination.
  const cleanup = [];
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
  if (cleanup.some(row => row.error || row.witness_error)) process.exitCode = 1;
}
