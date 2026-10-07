import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import sharp from "sharp";
import { openForkArtifact } from "./check-cua-fork-artifact.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { loadComputerConfig } from "../src/config.ts";

// Explicitly opt-in, approved exact-artifact qualification. Never installs or changes runtime config.
// Creates only isolated Chrome fixture windows; native CUA remains the sole capture/input backend.
// Send finish before changing workspace or closing the owning terminal; a hard interruption may need owned-fixture cleanup.
assert.equal(process.argv[4], "--live-approved", "Pass artifact directory, source SHA and --live-approved after owner approval.");
const directory = `.tmp/lpt-618/live-${Date.now()}`; await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const nativeRoot = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
assert.ok(nativeRoot.startsWith("C:\\"));
const source = process.argv[3];
const artifact = await openForkArtifact(process.argv[2], source);
const fixtures = []; const reports = [];
const colors = ["#164aff", "#1dcc68"];
const server = createServer((request, response) => {
  const index = Number(new URL(request.url, "http://localhost").pathname.slice(1));
  if (![0, 1].includes(index)) { response.writeHead(404).end(); return; }
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><title>Pi selected display fixture ${index + 1}</title>
<style>html,body{margin:0;height:100%;background:${colors[index]};color:white;font:36px sans-serif}
main{height:100%;display:grid;place-content:center;text-align:center}strong{font-size:52px}</style>
<main><strong>DISPLAY FIXTURE ${index + 1}</strong><p>Native selected-monitor pixels</p></main>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const call = async (name, args) => {
  const result = await artifact.call(name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`);
  return result;
};
try {
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-EncodedCommand",
    Buffer.from(await readFile(new URL("./report-windows-displays.ps1", import.meta.url), "utf8"), "utf16le").toString("base64")], { timeout: 20000 });
  const os = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  const discovery = await call("list_displays", {});
  const { displays, topology_id } = discovery.structuredContent;
  await writeFile(`${directory}/discovery.json`, JSON.stringify({ source, os, discovery: discovery.structuredContent }, null, 2));
  assert.ok(displays.length >= 2, "Two already connected native monitors required; do not install or rearrange displays.");
  for (const d of displays) {
    const report = os.find(row => row.display_id === d.display_id); assert.ok(report, "OS report has native ID");
    for (const field of ["bounds", "work_area", "primary", "scale_factor", "dpi"]) assert.deepEqual(d[field], report[field], `${d.display_id} ${field}`);
  }
  for (let i = 0; i < 2; i++) {
    const d = displays[i]; const fixture = await openCompleteInputWindow(artifact, `${url}/${i}`, nativeRoot); fixtures.push(fixture);
    await call("set_window_frame", { ...fixture.target, x: d.bounds.x + 80, y: d.bounds.y + 80,
      width: Math.min(900, d.bounds.width - 160), height: Math.min(700, d.bounds.height - 160) });
    await delay(600);
    const window = await call("get_window_state", { ...fixture.target, max_image_dimension: 500 });
    const bounds = window.structuredContent.window_bounds;
    assert.ok(bounds && bounds.x >= d.bounds.x && bounds.y >= d.bounds.y &&
      bounds.x + bounds.width <= d.bounds.x + d.bounds.width && bounds.y + bounds.height <= d.bounds.y + d.bounds.height,
      "Owned fixture must fit the selected native monitor.");
    // Compare actual native pixels, not CSS RGB: display/browser color management can change the values.
    const windowImage = window.content.find(b => b.type === "image"); assert.equal(windowImage?.mimeType, "image/png");
    const windowPixels = Buffer.from(windowImage.data, "base64");
    const windowSize = await sharp(windowPixels).metadata();
    const sample = { x: 0.5, y: 0.85 }; // Plain owned background below the fixture text.
    const nativeRgb = [...(await sharp(windowPixels).extract({ left: Math.floor(windowSize.width * sample.x),
      top: Math.floor(windowSize.height * sample.y), width: 1, height: 1 }).removeAlpha().raw().toBuffer())];
    const expected = i ? [29, 204, 104] : [22, 74, 255];
    await writeFile(`${directory}/window-${i}.png`, windowPixels);
    await writeFile(`${directory}/window-${i}.json`, JSON.stringify({ target: fixture.target, bounds, nativeRgb, expected, state: window.structuredContent }, null, 2));
    const dominant = i ? 1 : 2;
    assert.ok(nativeRgb[dominant] > 180 && nativeRgb.every((channel, n) => n === dominant || nativeRgb[dominant] - channel > 60),
      "Owned window has its distinct green/blue marker; CSS RGB is not a native-pixel oracle.");
    const point = { left: Math.floor(bounds.x + bounds.width * sample.x - d.bounds.x), top: Math.floor(bounds.y + bounds.height * sample.y - d.bounds.y) };
    let capture; let rgb;
    for (let attempt = 0; attempt < 6; attempt++) {
      capture = await call("get_display_state", { display_id: d.display_id, topology_id, max_image_dimension: 0 });
      const image = capture.content.find(b => b.type === "image"); assert.equal(image?.mimeType, "image/png");
      const pixels = Buffer.from(image.data, "base64");
      rgb = [...(await sharp(pixels).extract({ ...point, width: 1, height: 1 }).removeAlpha().raw().toBuffer())];
      const diagnostic = { display: d, bounds, point, rgb, attempt, native: capture.structuredContent, window: window.structuredContent };
      await writeFile(`${directory}/marker-${i}.json`, JSON.stringify(diagnostic, null, 2));
      const windowImage = window.content.find(b => b.type === "image");
      if (windowImage) await writeFile(`${directory}/window-${i}.png`, Buffer.from(windowImage.data, "base64"));
      await sharp(pixels).extract({ left: Math.max(0, point.left - 100), top: Math.max(0, point.top - 80), width: 200, height: 160 })
        .toFile(`${directory}/marker-${i}.png`);
      if (rgb.slice(0, 3).every((channel, n) => Math.abs(channel - nativeRgb[n]) < 3)) break;
      await delay(250); // Read-only paint check; never repeat input.
    }
    assert.ok(rgb.slice(0, 3).every((channel, n) => Math.abs(channel - nativeRgb[n]) < 3), "Exact native display matches the independent native window marker.");
    const image = capture.content.find(b => b.type === "image");
    assert.equal(capture.structuredContent.display.display_id, d.display_id);
    assert.equal(capture.structuredContent.screenshot_width, d.bounds.width);
    assert.equal(capture.structuredContent.screenshot_height, d.bounds.height);
    assert.equal(capture.structuredContent.capture_id, undefined);
    reports.push({ display: d, title: `Pi selected display fixture ${i + 1}`, target: fixture.target, bounds, point, rgb, nativeRgb,
      native_pixels: { width: d.bounds.width, height: d.bounds.height, hash: createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex") } });
  }
  const missing = await artifact.call("get_display_state", { display_id: "not-a-connected-display", topology_id });
  const mismatch = await artifact.call("get_display_state", { display_id: displays[0].display_id, topology_id: "mismatched-topology" });
  for (const result of [missing, mismatch]) {
    assert.equal(result.isError, true); assert.ok(result.content.every(b => b.type !== "image"));
  }
  const primary = await call("get_desktop_state", { max_image_dimension: 500 });
  assert.equal(primary.structuredContent.display, "primary");
  const result = { source, artifact: artifact.report, os, topology_id, displays: reports,
    refused_missing: missing.structuredContent, refused_topology: mismatch.structuredContent, legacy_primary: primary.structuredContent,
    limits: "No display topology/setup changes. Membership of ordinary windows not inferred. No selected-display input." };
  await writeFile(`${directory}/native.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ directory, url, ...result }));
  console.log("Owned fixtures ready for production computer_* checks. Send finish for cleanup.");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) if (line.trim() === "finish") break;
  input.close();
} finally {
  const cleanup = [];
  for (const fixture of fixtures.reverse()) cleanup.push(await fixture.close());
  await artifact.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
}
