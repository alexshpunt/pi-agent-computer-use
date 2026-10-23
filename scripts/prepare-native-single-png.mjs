import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Generate the narrow fork patch without editing the active CUA checkout.
export const SOURCE = "506239da08cfdafa63dac1857f5471752fb70f5e";
// Path to a local checkout of the CUA fork.
const repo = process.argv[2] ?? process.env.CUA_SOURCE;
if (!repo) throw new Error("Pass the CUA fork checkout as the first argument or set CUA_SOURCE.");
const testsOnly = process.argv.includes("--tests-only");
const directory = path.resolve(`.tmp/single-png/${testsOnly ? "red" : "generated"}`);
const root = "libs/cua-driver/rust/crates/";
const core = `${root}cua-driver-core/src/image_utils.rs`;
const capture = `${root}platform-windows/src/capture.rs`;
const owner = `${root}platform-windows/src/tools/impl_.rs`;
const files = new Map();
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
function replace(s, before, after) {
  assert.equal(s.split(before).length, 2, `Expected one immutable-source anchor: ${before.slice(0, 100)}`);
  return s.replace(before, after);
}
let utils = git("show", `${SOURCE}:${core}`);
utils += "\n" + await readFile("scripts/native-single-png-tests.rs", "utf8");
if (!testsOnly) {
  utils = replace(utils, "// ── Tests ─────────────────────────────────────────────────────────────────", `/// Resize top-down BGRA pixels before encoding one final PNG.
///
/// A zero cap keeps native size. Channel order, alpha, aspect rounding and
/// Lanczos3 match the legacy BGRA-to-PNG then PNG-resize path.
pub fn encode_bgra_to_png_resized(bgra: &[u8], w: u32, h: u32, max_dim: u32) -> Result<Vec<u8>> {
    if bgra.len() as u64 != (w as u64) * (h as u64) * 4 {
        bail!("encode_bgra_to_png_resized: invalid buffer for w={w} h={h}");
    }
    let mut rgba = bgra.to_vec();
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let buf = ImageBuffer::from_raw(w, h, rgba)
        .ok_or_else(|| anyhow!("invalid RGBA buffer for w={w} h={h}"))?;
    let img = DynamicImage::ImageRgba8(buf);
    let img = if max_dim != 0 && (w > max_dim || h > max_dim) {
        let scale = max_dim as f64 / w.max(h) as f64;
        let new_w = (w as f64 * scale).round() as u32;
        let new_h = (h as f64 * scale).round() as u32;
        img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)?;
    Ok(out)
}

// ── Tests ─────────────────────────────────────────────────────────────────`);
  let s = git("show", `${SOURCE}:${capture}`);
  s = replace(s, "fn screenshot_window_mapped(hwnd: u64) -> Result<(Vec<u8>, bool, Option<FrameGeometry>)> {\n    match unsafe { screenshot_window_bytes_with_occlusion_unsafe(hwnd) } {", `/// Capture a window overview with one PNG encoding after optional pixel resize.
/// Returns final PNG and original physical frame dimensions for input mapping.
pub fn screenshot_window_overview(hwnd: u64, max_dim: u32) -> Result<(Vec<u8>, u32, u32)> {
    screenshot_window_encoded(hwnd, |pixels, w, h| {
        let png = cua_driver_core::image_utils::encode_bgra_to_png_resized(pixels, w, h, max_dim)?;
        Ok((png, w, h))
    }).map(|(overview, _, _)| overview)
}

fn screenshot_window_mapped(hwnd: u64) -> Result<(Vec<u8>, bool, Option<FrameGeometry>)> {
    screenshot_window_encoded(hwnd, cua_driver_core::image_utils::encode_bgra_to_png)
}

fn screenshot_window_encoded<T>(
    hwnd: u64,
    encode: impl Fn(&[u8], u32, u32) -> Result<T> + Copy,
) -> Result<(T, bool, Option<FrameGeometry>)> {
    match unsafe { screenshot_window_bytes_with_occlusion_unsafe(hwnd, encode) } {`);
  s = replace(s, "unsafe fn screenshot_window_bytes_with_occlusion_unsafe(\n    hwnd: u64,\n) -> Result<(Vec<u8>, bool, Option<FrameGeometry>)> {", `unsafe fn screenshot_window_bytes_with_occlusion_unsafe<T>(
    hwnd: u64,
    encode: impl Fn(&[u8], u32, u32) -> Result<T> + Copy,
) -> Result<(T, bool, Option<FrameGeometry>)> {`);
  const start = s.indexOf("fn screenshot_window_encoded<T>(");
  const end = s.indexOf("// NOTE: previously this module", start);
  assert.ok(end > start);
  const section = s.slice(start, end);
  assert.equal(section.split("cua_driver_core::image_utils::encode_bgra_to_png(").length - 1, 7);
  s = s.slice(0, start) + section.replaceAll("cua_driver_core::image_utils::encode_bgra_to_png(", "encode(") + s.slice(end);
  s = replace(s, `    // BGRA → PNG via the shared \`image_utils::encode_bgra_to_png\`
    // helper (extracted from this file 2026-05; was a hand-rolled
    // uncompressed-PNG path that produced ~5x larger output. The
    // \`image\` crate's encoder is already a workspace dep so the
    // smaller output is free).`, `    // Encode the captured BGRA frame. Overviews resize pixels first;
    // existing recording/detail/mapped-click callers keep native-size PNGs.`);
  files.set(capture, s);
  let t = git("show", `${SOURCE}:${owner}`);
  t = replace(t, `                match crate::capture::screenshot_window_bytes(hwnd) {
                    Ok(raw) => {
                        let (native_w, native_h) = crate::capture::png_dimensions_pub(&raw)?;
                        let png = crate::capture::resize_png_if_needed(&raw, max_dim)?;`, `                match crate::capture::screenshot_window_overview(hwnd, max_dim) {
                    Ok((png, native_w, native_h)) => {`);
  files.set(owner, t);
}
files.set(core, utils);
for (const [file, content] of files) {
  const target = path.join(directory, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  execFileSync("rustfmt", ["+1.97.1", "--edition", "2021", "--config", "skip_children=true", target]);
  files.set(file, await readFile(target, "utf8"));
}
const manifest = { source: SOURCE, testsOnly, directory, files: [...files].map(([file, content]) => ({ file, sha256: createHash("sha256").update(content).digest("hex") })) };
await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ source: SOURCE, testsOnly, files: files.size, manifest: `${directory}/manifest.json` }));
