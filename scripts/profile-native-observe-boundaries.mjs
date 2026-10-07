import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { McpDriver, SHELL_DESKTOP_RUNTIME } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { finishProfile } from "../src/browser-profile.ts";
import { createUiResourcesSite } from "../test/fixtures/ui-resources-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";

// Read-only public-native boundary probes, not timers inside the Driver.
const args = process.argv.slice(2);
assert.ok(args.length <= 1 && (!args.length || /^[1-9]\d*$/.test(args[0])), "Usage: [1..20 samples]");
const repeats = Number(args[0] ?? 10);
assert.ok(repeats <= 20, "At most 20 samples per boundary.");
const directory = `.tmp/native-observe-profile/run-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
assert.equal(config.runtime, "windows-shell-desktops", "Require the inspected exact native source.");
const native = new McpDriver(config);
const abort = new AbortController();
const interrupt = () => abort.abort();
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
const samples = [];
let site, fixture, completed = false, stage = "fixture_start";
const modes = ["metadata_rejection", "image_500", "image_native", "file_500", "ui_only"];
try {
  site = await createUiResourcesSite();
  const root = path.dirname(config.command);
  assert.ok(root.startsWith("/mnt/c/"), "Require the qualified Windows runtime.");
  fixture = await openCompleteInputWindow(native, site.url, root.replace("/mnt/c/", "C:\\").replaceAll("/", "\\"));
  const file = `${fixture.profile}\\profile-capture.png`;
  const probe = async (mode, phase) => {
    if (abort.signal.aborted) throw Error("Cancelled");
    stage = mode;
    const options = { include_accessibility_tree: false, max_image_dimension: 500 };
    if (mode === "metadata_rejection") options.include_screenshot = false;
    if (mode === "image_native") options.max_image_dimension = 0;
    if (mode === "file_500") options.screenshot_out_file = file;
    if (mode === "ui_only") Object.assign(options, { include_accessibility_tree: true, include_screenshot: false });
    const start = performance.now();
    const result = await native.call("get_window_state", { ...fixture.target, ...options }, abort.signal);
    const sample = { mode, phase, duration_ms: performance.now() - start, verified: false,
      image_blocks: result.content.filter(c => c.type === "image").length,
      screenshot_error: !!result.structuredContent?.screenshot_error,
      file_path_matches: mode === "file_500" ? [file, `\\\\?\\${file}`].includes(result.structuredContent?.screenshot_file_path) : undefined };
    samples.push(sample);
    if (mode === "metadata_rejection") {
      assert.equal(result.isError, true);
      assert.ok(result.content.some(c => c.type === "text" && c.text.includes("Nothing to return: both include_accessibility_tree:false and")), "Require the inspected late validation refusal, not another error.");
    } else {
      assert.ok(!result.isError, "Native observation failed.");
      const images = result.content.filter(c => c.type === "image");
      assert.equal(images.length, mode === "ui_only" || mode === "file_500" ? 0 : 1);
      let png;
      if (mode === "file_500") {
        assert.equal(sample.file_path_matches, true, "Only this exact owned file or its Windows extended-path form is allowed.");
        png = await readFile(file.replace("C:\\", "/mnt/c/").replaceAll("\\", "/"));
      } else if (images.length) png = Buffer.from(images[0].data, "base64");
      if (png) {
        assert.equal(png.subarray(1, 4).toString(), "PNG");
        sample.dimensions = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
        sample.png_bytes = png.length;
        if (mode !== "image_native") assert.equal(Math.max(...Object.values(sample.dimensions)), 500);
        if (phase === "setup" && mode === "image_500") await writeFile(`${directory}/owned-overview.png`, png);
      }
      assert.equal(Array.isArray(result.structuredContent.elements), mode === "ui_only");
    }
    sample.verified = true;
  };
  for (const mode of modes) await probe(mode, "setup");
  for (let i = 0; i < repeats; i++) {
    // Rotate ordering to avoid assigning first/last-in-round effects to one mode.
    for (let n = 0; n < modes.length; n++) await probe(modes[(i + n) % modes.length], "warm");
  }
  assert.equal(site.events().length, 0, "Measured probes must send no app input.");
  completed = true;
} catch (error) {
  await writeFile(`${directory}/private-failure.txt`, String(error));
  console.error(`Profile stopped at ${stage}; no input replay.`);
}
finally {
  const cleanup = await finishProfile(completed, {
    fixture: async () => { assert.ok(fixture, "Fixture ownership not established."); const r = await fixture.close(); assert.ok(r.sourceGone && r.profileRemoved); },
    native: () => native.close(),
    site: async () => { await site?.close(); },
  });
  const summary = modes.map(mode => {
    const rows = samples.filter(s => s.mode === mode && s.phase === "warm" && s.verified);
    const times = rows.map(s => s.duration_ms).sort((a, b) => a - b);
    return { mode, count: times.length, mean_ms: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
      median_ms: times.length ? (times[Math.floor((times.length - 1) / 2)] + times[Math.floor(times.length / 2)]) / 2 : null };
  });
  const report = { schema: 1, ...cleanup, source: SHELL_DESKTOP_RUNTIME.source, runtime_sha256: SHELL_DESKTOP_RUNTIME.sha256,
    boundary: "Native public RPC through the unchanged McpDriver; includes native work, transport, SDK parsing and result projection. No Pi hooks or overlay.",
    caveat: "metadata_rejection is the exact late-validation error after lookup/process enumeration/shell membership, not a screenshot. Differences across public calls are comparative evidence, not additive internal timers. file_500 includes file write; image_native skips resize but transports a larger PNG.",
    no_input_during_samples: completed, summary, samples };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ success: report.success, cleanup: report.cleanup, summary, report: `${directory}/report.json` }));
  if (!report.success) process.exitCode = 1;
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
}
