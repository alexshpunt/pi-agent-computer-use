import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerSession } from "../src/session.ts";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { CuaBrowser } from "../src/cua-browser.ts";
import { WindowHighlights } from "../src/window-highlights.ts";
import { createCuaBrowserSite } from "../test/fixtures/cua-browser-site.mjs";

// Resize only this disposable fixture. CUA remains the only capture/input backend.
const directory = `.tmp/region-highlights/geometry-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const driver = new McpDriver(config);
const marks = new WindowHighlights();
const session = new ComputerSession(driver, undefined, undefined, marks.flash);
const browser = new CuaBrowser(async () => new McpDriver(config));
const site = await createCuaBrowserSite();
const records = [];
let target; let success = false;
function position(x, y, width, height) {
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type 'using System; using System.Runtime.InteropServices; public class ZoomFixture {
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
[DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags); }';
if([ZoomFixture]::SetThreadDpiAwarenessContext([IntPtr](-4))-eq[IntPtr]::Zero) { throw 'Physical fixture coordinates unavailable'; }
[uint32]$owner=0; [void][ZoomFixture]::GetWindowThreadProcessId([IntPtr]${target.window_id},[ref]$owner);
if($owner-ne${target.pid}) { throw 'Fixture identity changed'; }
if(-not[ZoomFixture]::SetWindowPos([IntPtr]${target.window_id},[IntPtr]::Zero,${x},${y},${width},${height},20)) { throw 'Fixture placement failed'; }
@{positioned=$true}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }));
}
try {
  const open = await browser.call("open", { url: site.url });
  assert.equal(open.details.status, "observed", open.details.text);
  target = { pid: open.details.agent_image.native.pid, window_id: open.details.agent_image.native.window_id };
  const listed = await session.windows();
  const found = listed.details.state.windows.filter(w => w.pid === target.pid && w.window_id === target.window_id);
  assert.equal(found.length, 1);
  const ref = found[0].window_ref;
  const rectangle = { x: 270, y: 180, width: 180, height: 120 };
  for (const [label, destination] of [
    ["baseline", [40, 40, 1350, 960]], ["move", [180, 140, 1350, 960]],
    ["shrink", [180, 140, 1000, 750]], ["grow", [180, 140, 1700, 1100]],
  ]) {
    position(40, 40, 1350, 960); await delay(150);
    const overview = await session.observe(ref);
    assert.equal(overview.details.status, "observed");
    position(...destination); await delay(150);
    const result = await session.observe(ref, undefined, undefined, { image_id: overview.details.agent_image.image_id, ...rectangle });
    assert.equal(result.details.status, "observed", result.content[0]?.text);
    assert.equal(result.details.highlight.status, "shown");
    assert.equal(result.details.highlight.kind, "detail");
    assert.equal(result.details.source.capabilities.input, "none");
    assert.deepEqual(result.details.agent_image.region.overview, {
      image_id: overview.details.agent_image.image_id, dimensions: overview.details.source.image.dimensions, ...rectangle,
    });
    const image = result.content.find(block => block.type === "image");
    assert.equal(image.mimeType, "image/jpeg");
    await writeFile(`${directory}/${label}.jpg`, Buffer.from(image.data, "base64"));
    records.push({ label, overview: overview.details.source.image, output: result.details.agent_image.output, highlight: result.details.highlight });
  }
  assert.deepEqual([records[1].output.width, records[1].output.height], [records[0].output.width, records[0].output.height]);
  assert.deepEqual([records[3].output.width, records[3].output.height], [records[0].output.width, records[0].output.height]);
  assert.ok(records[2].output.width < records[0].output.width, "Shrink must clip the native crop, not stretch it.");
  assert.equal(records[3].highlight.region.width, records[1].highlight.region.width);
  assert.equal(records[3].highlight.region.height, records[1].highlight.region.height);
  assert.ok(records[2].highlight.region.width < records[1].highlight.region.width);
  assert.ok(records[2].highlight.region.height < records[1].highlight.region.height);
  success = true;
} finally {
  const closed = await browser.call("close", {});
  await session.close(); await marks.close(); await site.close();
  await writeFile(`${directory}/run.json`, JSON.stringify({ success, records, cleanup: closed.details.status }, null, 2));
  assert.equal(closed.details.status, "closed");
}
console.log(JSON.stringify({ success, directory, cases: records.length }));
