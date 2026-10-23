import assert from "node:assert/strict";
import path from "node:path";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Code generator: writes only ignored diagnostic source, never the CUA checkout.
export const SOURCE = process.argv[3] ?? "506239da08cfdafa63dac1857f5471752fb70f5e";
assert.match(SOURCE, /^[0-9a-f]{40}$/);
// Path to a local checkout of the CUA fork.
const repo = process.argv[2] ?? process.env.CUA_SOURCE;
if (!repo) throw new Error("Pass the CUA fork checkout as the first argument or set CUA_SOURCE.");
const directory = path.resolve(process.argv[4] ?? ".tmp/native-observe-profile/generated");
const rust = "libs/cua-driver/rust/crates/";
const core = `${rust}cua-driver-core/src/`;
const windows = `${rust}platform-windows/src/`;
const cli = `${rust}cua-driver/src/`;
const files = new Map();
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
assert.equal(git("rev-parse", SOURCE).trim(), SOURCE);
function replace(text, before, after) {
  assert.equal(text.split(before).length, 2, `Require one pinned-source match: ${before.slice(0, 90)}`);
  return text.replace(before, after);
}
function section(text, from, to, work) {
  assert.equal(text.split(from).length, 2);
  const first = text.indexOf(from), last = text.indexOf(to, first + from.length);
  assert.ok(last > first, `Missing pinned owner end: ${to}`);
  return text.slice(0, first) + work(text.slice(first, last)) + text.slice(last);
}
function edit(file, work) { files.set(file, work(git("show", `${SOURCE}:${file}`))); }
const span = (label, owner = "cua_driver_core") => `${owner}::native_observe_profile::Span::new("${label}")`;
const timed = (label, expr, owner = "cua_driver_core") => `${owner}::native_observe_profile::timed("${label}", || ${expr})`;
edit(`${core}lib.rs`, s => replace(s, "pub mod image_utils;", "pub mod image_utils;\npub mod native_observe_profile;"));
files.set(`${core}native_observe_profile.rs`, await readFile("scripts/native-observe-trace.rs", "utf8"));
edit(`${cli}mcp_envelope.rs`, s => {
  s = replace(s, "        let raw: Value = match serde_json::from_slice(&line) {", "        let trace_start = std::time::Instant::now();\n        let raw: Value = match serde_json::from_slice(&line) {");
  s = replace(s, "        tasks.spawn(async move {", `        let native_trace = request.tool_call().ok().filter(|c| c.name == "get_window_state")\n            .map(|_| cua_driver_core::native_observe_profile::Root::begin(trace_start));
        if let Some(trace) = &native_trace { trace.record("wire.parse_and_admit", trace_start, std::time::Instant::now()); }
        let task_queue = ${span("wire.task_queue")};
        tasks.spawn(async move {
            drop(task_queue);`);
  s = replace(s, "                let _guard = serial.lock().await;", `                let serial_wait = ${span("wire.serial_wait")};\n                let _guard = serial.lock().await;\n                drop(serial_wait);\n                let pre_dispatch = ${span("sdk.pre_dispatch")};`);
  s = replace(s, "                let response = cua_driver_core::server::handle_request_with_transport_session(", `                drop(pre_dispatch);\n                let dispatch = ${span("sdk.dispatch")};\n                let response = cua_driver_core::server::handle_request_with_transport_session(`);
  s = replace(s, "                if let Some(timer) = timer {", "                drop(dispatch);\n                if let Some(timer) = timer {");
  s = replace(s, "            write_response(&writer, response).await?;", "            write_response(&writer, response).await?;\n            drop(native_trace);");
  s = replace(s, "    let mut bytes = serde_json::to_vec(&response)?;", `    let mut bytes = ${timed("wire.response_serialize", "serde_json::to_vec(&response)")}?;`);
  s = replace(s, "        let mut writer = writer.lock().await;", `        let lock_wait = ${span("wire.writer_wait")};\n        let mut writer = writer.lock().await;\n        drop(lock_wait);\n        let _output = ${span("wire.stdout_write_flush")};`);
  return s;
});
edit(`${windows}tools/impl_.rs`, s => section(s, "impl Tool for GetWindowStateTool {", "/// Split a `launch_path`", t => {
  t = replace(t, "    async fn invoke(&self, args: Value) -> ToolResult {", `    async fn invoke(&self, args: Value) -> ToolResult {\n        let _invoke = ${span("windows.invoke")};`);
  t = replace(t, "        let lookup =", `        let lookup_wait = ${span("metadata.lookup_await")};\n        let lookup =`);
  t = replace(t, "move || crate::win32::lookup_window_for_pid(pid, hwnd)", `move || ${timed("metadata.window_lookup", "crate::win32::lookup_window_for_pid(pid, hwnd)")}`);
  t = replace(t, "                .unwrap_or(PidWindowLookup::Missing);", "                .unwrap_or(PidWindowLookup::Missing);\n        drop(lookup_wait);");
  t = replace(t, "        let (app_name, virtual_desktop) = tokio::task::spawn_blocking(move || {", `        let metadata_wait = ${span("metadata.worker_await")};\n        let (app_name, virtual_desktop) = tokio::task::spawn_blocking(move || {\n            let _metadata = ${span("metadata.worker")};`);
  t = replace(t, "        use cua_driver_core::tool_args::ArgsExt;", "        drop(metadata_wait);\n        use cua_driver_core::tool_args::ArgsExt;");
  t = replace(t, "            let tree_task = tokio::task::spawn_blocking(move || {", `            let tree_task = tokio::task::spawn_blocking(move || {\n                let _tree = ${span("uia.walk_and_snapshot")};`);
  t = replace(t, "        let blocking = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {", `        let screenshot_wait = ${span("capture.worker_await")};\n        let blocking = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {\n            let _capture = ${span("capture.worker")};`);
  if (t.includes("crate::capture::screenshot_window_overview(hwnd, max_dim)")) {
    t = replace(t, "crate::capture::screenshot_window_overview(hwnd, max_dim)", timed("image.overview_pipeline", "crate::capture::screenshot_window_overview(hwnd, max_dim)"));
  } else {
    t = replace(t, "                        let png = crate::capture::resize_png_if_needed(&raw, max_dim)?;", `                        let png = ${timed("image.resize_pipeline", "crate::capture::resize_png_if_needed(&raw, max_dim)")}?;`);
  }
  t = replace(t, "B64.encode(&png)", timed("image.base64", "B64.encode(&png)"));
  t = replace(t, "        let result =\n            result.map", "        drop(screenshot_wait);\n        let result =\n            result.map");
  t = replace(t, "                            match bridge.publish(", "                            match cua_driver_core::native_observe_profile::timed(\"capture.publish\", || bridge.publish(");
  t = replace(t, "                                geometry,\n                            ) {", "                                geometry,\n                            )) {");
  return t;
}));
edit(`${windows}win32/apps.rs`, s => {
  if (s.includes("pub(crate) fn process_name(pid: u32)")) {
    s = section(s, "pub(crate) fn process_name(pid: u32)", "/// Return all running processes", t =>
      replace(t, "    use windows::core::PWSTR;", `    let _lookup = ${span("metadata.direct_process_name")};\n    use windows::core::PWSTR;`));
  }
  return section(s, "pub fn list_processes()", "fn decode_wstr", t => {
    t = replace(t, "    let mut result = Vec::new();", `    let _processes = ${span("metadata.process_enumeration")};\n    let mut result = Vec::new();`);
    return replace(t, "CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)", timed("metadata.process_snapshot", "CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)"));
  });
});
edit(`${windows}wgc.rs`, s => {
  s = replace(s, "unsafe fn wgc_capture_impl(hwnd: HWND) -> Result<(Vec<u8>, u32, u32)> {", `unsafe fn wgc_capture_impl(hwnd: HWND) -> Result<(Vec<u8>, u32, u32)> {\n    let _capture = ${span("wgc.total")};`);
  s = replace(s, "    let mut d3d_device: Option<ID3D11Device> = None;", `    let device = ${span("wgc.device_setup")};\n    let mut d3d_device: Option<ID3D11Device> = None;`);
  s = replace(s, "    let item_size = item.Size().context(\"GraphicsCaptureItem::Size\")?;", "    let item_size = item.Size().context(\"GraphicsCaptureItem::Size\")?;\n    drop(device);");
  s = replace(s, "    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(", `    let setup = ${span("wgc.pool_session_setup")};\n    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(`);
  s = replace(s, "    let deadline = std::time::Instant::now() + Duration::from_millis(1500);", `    drop(setup);\n    let wait = ${span("wgc.first_frame_wait")};\n    let deadline = std::time::Instant::now() + Duration::from_millis(1500);`);
  s = replace(s, "    let surface = frame.Surface().context(\"frame.Surface\")?;", `    drop(wait);\n    let staging_setup = ${span("wgc.staging_setup")};\n    let surface = frame.Surface().context(\"frame.Surface\")?;`);
  s = replace(s, "    d3d_context.CopyResource(&staging, &frame_texture);", `    drop(staging_setup);\n    let readback = ${span("wgc.copy_and_map")};\n    d3d_context.CopyResource(&staging, &frame_texture);`);
  s = replace(s, "    let width = desc.Width as usize;", `    drop(readback);\n    let copy = ${span("wgc.rows_to_bgra")};\n    let width = desc.Width as usize;`);
  s = replace(s, "    d3d_context.Unmap(&staging, 0);", "    d3d_context.Unmap(&staging, 0);\n    drop(copy);");
  s = replace(s, "    let _ = session.Close();", `    let _cleanup = ${span("wgc.cleanup")};\n    let _ = session.Close();`);
  return s;
});
edit(`${windows}shell_desktop.rs`, s => {
  s = replace(s, "CoInitializeEx(None, COINIT_MULTITHREADED)", timed("shell.COM_initialize", "CoInitializeEx(None, COINIT_MULTITHREADED)"));
  s = replace(s, "CoUninitialize()", timed("shell.COM_uninitialize", "CoUninitialize()"));
  s = replace(s, "    pub(crate) fn new() -> Self {", `    pub(crate) fn new() -> Self {\n        let _construct = ${span("shell.context_construct")};`);
  s = replace(s, "CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL)", timed("shell.CoCreateInstance", "CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL)"));
  s = replace(s, "    pub(crate) fn read(&self, pid: u32, window_id: u64) -> VirtualDesktopMembership {", `    pub(crate) fn read(&self, pid: u32, window_id: u64) -> VirtualDesktopMembership {\n        let _queries = ${span("shell.membership")};`);
  s = replace(s, "manager.GetWindowDesktopId(hwnd)", timed("shell.desktop_id", "manager.GetWindowDesktopId(hwnd)"));
  s = replace(s, "manager.IsWindowOnCurrentVirtualDesktop(hwnd)", timed("shell.current_desktop", "manager.IsWindowOnCurrentVirtualDesktop(hwnd)"));
  return s;
});
edit(`${windows}capture.rs`, s => section(s, "unsafe fn screenshot_window_bytes_with_occlusion_unsafe", "// `encode_bgra_to_png`", t => {
  t = replace(t, "    let hwnd_raw = hwnd;", `    let _grab = ${span("capture.windows_grab")};\n    let hwnd_raw = hwnd;`);
  t = replace(t, "    let screen_dc = GetWindowDC(hwnd);", `    let setup = ${span("capture.GDI_setup")};\n    let screen_dc = GetWindowDC(hwnd);`);
  t = replace(t, "    let old_bitmap = SelectObject(mem_dc, bitmap);", "    let old_bitmap = SelectObject(mem_dc, bitmap);\n    drop(setup);");
  t = replace(t, "PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)", timed("capture.PrintWindow", "PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)"));
  t = replace(t, "    let pixel_count = (w * h) as usize;", `    let readback = ${span("capture.readback_and_cleanup")};\n    let pixel_count = (w * h) as usize;`);
  t = replace(t, "    ReleaseDC(hwnd, screen_dc);", "    ReleaseDC(hwnd, screen_dc);\n    drop(readback);");
  t = replace(t, "    let cropped_geometry =", `    let crop = ${span("capture.DWM_crop")};\n    let cropped_geometry =`);
  t = replace(t, "    let mostly_black = is_mostly_black_bgra(&pixels);", `    drop(crop);\n    let mostly_black = ${timed("capture.black_check", "is_mostly_black_bgra(&pixels)")};`);
  return t;
}));
edit(`${core}image_utils.rs`, s => {
  s = section(s, "pub fn resize_png_if_needed(", "// ── Crosshair", t => {
    t = replace(t, "    let cursor = std::io::Cursor::new(png_bytes);", `    let decode = ${span("image.PNG_decode", "crate")};\n    let cursor = std::io::Cursor::new(png_bytes);`);
    t = replace(t, "    decoder.read_image(&mut buf)?;", "    decoder.read_image(&mut buf)?;\n    drop(decode);");
    t = replace(t, "img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)", timed("image.Lanczos3", "img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)", "crate"));
    t = replace(t, "resized.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)", timed("image.resized_PNG_encode", "resized.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)", "crate"));
    return t;
  });
  s = section(s, "pub fn encode_rgba_to_png(", "/// Encode raw BGRA", t => {
    t = replace(t, "    let buf: ImageBuffer", `    let buffer = ${span("image.RGBA_buffer", "crate")};\n    let buf: ImageBuffer`);
    t = replace(t, "    let mut out = Vec::new();", `    drop(buffer);\n    let _encode = ${span("image.native_PNG_encode", "crate")};\n    let mut out = Vec::new();`);
    return t;
  });
  s = section(s, "pub fn encode_bgra_to_png(", s.includes("pub fn encode_bgra_to_png_resized(") ? (s.includes("/// Resize Windows top-down BGRA") ? "/// Resize Windows top-down BGRA" : "/// Resize top-down BGRA") : "// ── Tests", t => {
    t = replace(t, "    let mut rgba = bgra.to_vec();", `    let conversion = ${span("image.channel_conversion", "crate")};\n    let mut rgba = bgra.to_vec();`);
    t = replace(t, "    encode_rgba_to_png(&rgba, w, h)", "    drop(conversion);\n    encode_rgba_to_png(&rgba, w, h)");
    return t;
  });
  if (s.includes("pub fn encode_bgra_to_png_resized(")) {
    s = section(s, "pub fn encode_bgra_to_png_resized(", s.includes("pub fn resize_windows_overview_png(") ? "/// Downscale a Windows display overview" : "// ── Tests", t => {
      t = replace(t, "    let mut rgba = bgra.to_vec();", `    let conversion = ${span("image.channel_conversion", "crate")};\n    let mut rgba = bgra.to_vec();`);
      t = replace(t, "    let buf = ImageBuffer::from_raw(w, h, rgba)", `    drop(conversion);\n    let buffer = ${span("image.RGBA_buffer", "crate")};\n    let buf = ImageBuffer::from_raw(w, h, rgba)`);
      t = replace(t, "    let img = DynamicImage::ImageRgba8(buf);", "    drop(buffer);\n    let img = DynamicImage::ImageRgba8(buf);");
      if (t.includes("img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)"))
        t = replace(t, "img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)", timed("image.Lanczos3", "img.resize(new_w, new_h, image::imageops::FilterType::Lanczos3)", "crate"));
      t = replace(t, "img.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)", timed("image.final_PNG_encode", "img.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)", "crate"));
      return t;
    });
  }
  return s;
});
// The Bilinear diagnostic child stays separate from the production artifact.
// Time the actual owner, not a parallel benchmark implementation.
if (files.get(`${core}image_utils.rs`).includes("fn resize_windows_overview(")) {
  const file = `${core}image_utils.rs`;
  let s = files.get(file);
  s = section(s, "fn resize_windows_overview(", "// ── Tests", t =>
    replace(t, "    let pixel_type = match img.color() {",
      `    let _resize = ${span("image.Bilinear", "crate")};\n    let pixel_type = match img.color() {`));
  files.set(file, s);
}
for (const [file, text] of files) {
  const target = path.join(directory, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}
const manifest = { source: SOURCE, directory, files: [...files].map(([file, text]) => ({ file, sha256: createHash("sha256").update(text).digest("hex") })) };
await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ source: SOURCE, files: files.size, manifest: `${directory}/manifest.json` }));
