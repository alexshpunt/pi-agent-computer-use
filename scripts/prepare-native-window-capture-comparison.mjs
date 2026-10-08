import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Generate isolated timing builds. No public selector, checkout edit or runtime adoption.
// WGC variants are read-only experiments: their frame origin is not proven for input.
const [repo, source, output, route = "default"] = process.argv.slice(2);
assert.ok(repo && source && output, "Usage: node scripts/prepare-native-window-capture-comparison.mjs REPO SHA OUTPUT default|wgc|wgc-poll5");
assert.match(source, /^[a-f0-9]{40}$/);
assert.ok(["default", "wgc", "wgc-poll5"].includes(route));
const directory = path.resolve(output);
assert.ok(directory.startsWith(path.resolve(".tmp") + path.sep));
execFileSync(process.execPath, ["scripts/prepare-native-observe-trace.mjs", repo, source, directory], { stdio: "pipe" });
const manifestPath = path.join(directory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
function replace(text, before, after) {
  assert.equal(text.split(before).length, 2, `Require one source match: ${before.slice(0, 80)}`);
  return text.replace(before, after);
}
async function edit(suffix, change) {
  const row = manifest.files.find(row => row.file.endsWith(suffix));
  assert.ok(row, suffix);
  const file = path.join(directory, row.file);
  const text = change(await readFile(file, "utf8"));
  await writeFile(file, text);
  row.sha256 = createHash("sha256").update(text).digest("hex");
}
if (route !== "default") {
  await edit("platform-windows/src/capture.rs", s => replace(s,
    "    match unsafe { screenshot_window_bytes_with_occlusion_unsafe(hwnd, encode) } {",
    `    // Diagnostic only: no screen-region fallback or fabricated geometry.
    let (pixels, width, height) = crate::wgc::screenshot_window_via_wgc(hwnd)?;
    return Ok((encode(&pixels, width, height)?, false, None));
    #[allow(unreachable_code)]
    match unsafe { screenshot_window_bytes_with_occlusion_unsafe(hwnd, encode) } {`));
}
if (route === "wgc-poll5") {
  await edit("platform-windows/src/wgc.rs", s => replace(s,
    "std::thread::sleep(Duration::from_millis(50));",
    "std::thread::sleep(Duration::from_millis(5));"));
}
manifest.experiment = { route, diagnostic_only: true, input_qualified: false };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ source, route, files: manifest.files.length, manifest: manifestPath }));
