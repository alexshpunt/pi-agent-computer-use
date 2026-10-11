import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { loadComputerConfig } from "../src/config.ts";
import * as native from "../src/driver.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { createPointerHoverSite } from "../test/fixtures/pointer-hover-site.mjs";

// Setup and witnesses only. Measured movement must use production computer_* tools in Pi.
assert.ok(process.argv.includes("--live-approved"), "Explicit disposable-window approval is required.");
const config = await loadComputerConfig(process.cwd()), driver = new native.McpDriver(config);
assert.equal(driver.nativePointer, true, "Select the byte-checked native pointer candidate first.");
const pin = native.NATIVE_POINTER_RUNTIME;
assert.ok(pin?.source && pin?.sha256, "The selected candidate needs exact source and artifact evidence.");
const directory = `.tmp/lpt-729/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const site = await createPointerHoverSite(), windows = [];
let serial = 0;
const execute = promisify(execFile);
// Read-only Win32 metadata. No input, focus setter or capture API is used.
async function pointerState() {
  const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
Add-Type 'using System;using System.ComponentModel;using System.Runtime.InteropServices;
public class NativeHoverMetadata {
[StructLayout(LayoutKind.Sequential)] public struct POINT {public int x,y;}
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll",SetLastError=true)] static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
public static long[] Read(){POINT p;if(!GetCursorPos(out p))throw new Win32Exception(Marshal.GetLastWin32Error());
return new long[]{GetForegroundWindow().ToInt64(),p.x,p.y,GetAncestor(WindowFromPoint(p),2).ToInt64()};}
}';[NativeHoverMetadata]::Read()|ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execute("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 10000, env: { ...process.env, WSL_INTEROP: config.interop ?? process.env.WSL_INTEROP } });
    const values = JSON.parse(stdout);
    assert.ok(Array.isArray(values) && values.length === 4 && values.every(Number.isSafeInteger), "Invalid native metadata");
    return { status: "measured", measured_ms: Date.now(), foreground_window: values[0],
      pointer: { x: values[1], y: values[2], space: "windows_desktop_pixels", read_only: true }, window_at_pointer: values[3] };
  } catch (error) { return { status: "unavailable", reason: String(error), foreground_window: null, pointer: null, window_at_pointer: null }; }
}
const record = async label => {
  const native_state = await pointerState();
  const state = site.state();
  await writeFile(`${directory}/${++serial}-${label}.json`, JSON.stringify({ label, state, native_state }, null, 2));
  console.log(JSON.stringify({ label, directory, native_state, reports: state.reports,
    event_counts: state.events.map(rows => rows.length), dropped: state.dropped }));
};
try {
  const root = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
  for (let index = 0; index < 2; index++) windows.push(await openCompleteInputWindow(driver, `${site.url}/${index}`, root,
    ["--window-size=640,800", `--window-position=${index ? 760 : 60},60`]));
  for (let attempt = 0; attempt < 30 && !site.state().reports.every(Boolean); attempt++) await delay(100);
  assert.ok(site.state().reports.every(Boolean), "Both disposable pages must report readiness.");
  const fixture = { directory, url: site.url, runtime: config.runtime, candidate: pin,
    windows: windows.map((window, index) => ({ ...window.target, title: `Pi native hover ${index ? "sentinel" : "target"}`, profile: window.profile })) };
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
  // Save measured witnesses before any cleanup click or task-owned process termination.
  await record("before-cleanup");
  const cleanup = [];
  for (const window of windows.reverse()) {
    try { cleanup.push({ target: window.target, result: await window.close() }); }
    catch (error) { cleanup.push({ target: window.target, error: String(error) }); }
  }
  await driver.close(); await site.close();
  await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
  if (cleanup.some(row => row.error)) process.exitCode = 1;
}
