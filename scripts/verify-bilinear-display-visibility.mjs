import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { finishProfile } from "../src/browser-profile.ts";
import { createUiResourcesSite } from "../test/fixtures/ui-resources-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";

// Explicitly authorized foreground setup of one new owned fixture, never another app.
assert.ok(process.argv.includes("--foreground-owned-fixture"));
assert.ok(process.argv.includes("--private-displays"));
const plan = JSON.parse(await readFile(process.argv[2], "utf8"));
const configFile = path.resolve(plan.baselineConfig);
const originalConfig = await readFile(configFile);
const config = await loadComputerConfig(path.dirname(path.dirname(configFile)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const installedHash = hash(await readFile(config.command));
assert.equal(installedHash, "17cf450b3e202b9f4b4153133dfb8f4bc3d8121c5f2d0246a6c3ec78e3f49185");
assert.ok(typeof plan.interop === "string" && plan.interop.startsWith("/run/WSL/"));
const artifact = path.resolve(plan.candidate.directory);
assert.ok(artifact.startsWith(path.resolve(".tmp/fast-bilinear") + path.sep));
assert.equal(plan.candidate.source, "4825375a7d7827cd5dcf0f34924aa45611533853");
assert.equal((await readFile(path.join(artifact, "source-sha.txt"), "utf8")).trim(), plan.candidate.source);
const hashes = JSON.parse(await readFile(path.join(artifact, "hashes.json"), "utf8"));
assert.equal(hashes.length, 3);
for (const row of hashes) {
  assert.ok(["cua-driver.exe", "cua-driver-uia.exe", "cua-cursor-theme.exe"].includes(row.name));
  const actual = hash(await readFile(path.join(artifact, "runtime", row.name)));
  assert.equal(actual, row.Hash.toLowerCase());
  if (row.name === "cua-driver.exe") assert.equal(actual, plan.candidate.sha256);
}
const directory = `.tmp/fast-bilinear/display-visibility-${Date.now()}`;
const staged = path.join(path.dirname(config.command), ".tmp", "lpt-663", `visibility-${Date.now()}`);
await mkdir(directory, { recursive: true });
await cp(path.join(artifact, "runtime"), staged, { recursive: true, force: false, errorOnExist: true });
const driver = new McpDriver({ ...config, interop: plan.interop, command: path.join(staged, "cua-driver.exe"), runtime: "windows-fast-bilinear" });
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 60000);
const call = async (name, args) => {
  const result = await driver.call(name, args, abort.signal);
  assert.ok(!result.isError, `${name} refused; stop without replay.`);
  return result;
};
const png = result => {
  const images = result.content.filter(c => c.type === "image");
  assert.equal(images.length, 1); assert.equal(images[0].mimeType, "image/png");
  return Buffer.from(images[0].data, "base64");
};
let site, fixture, success = false;
const routes = [];
try {
  assert.equal(driver.overviewKernel, "bilinear");
  site = await createUiResourcesSite();
  const root = path.dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
  fixture = await openCompleteInputWindow(driver, site.url, root);
  const topology = (await call("list_displays", {})).structuredContent;
  const primary = topology.displays.find(d => d.primary); assert.ok(primary);
  const b = primary.bounds;
  await call("bring_to_front", fixture.target);
  await call("set_window_frame", { ...fixture.target, x: b.x + 40, y: b.y + 50,
    width: Math.floor(b.width * 0.8), height: Math.floor(b.height * 0.8) });
  const window = await call("get_window_state", { ...fixture.target, include_accessibility_tree: false, max_image_dimension: 500 });
  const bounds = window.structuredContent.window_bounds;
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
  await writeFile(`${directory}/owned-window.png`, png(window));
  for (const [capture, route] of ["primary", "selected", "primary", "selected"].entries()) {
    const result = await call(route === "primary" ? "get_desktop_state" : "get_display_state", route === "primary" ?
      { max_image_dimension: 500 } : { display_id: primary.display_id, topology_id: topology.topology_id, max_image_dimension: 500 });
    const bytes = png(result), metadata = await sharp(bytes).metadata();
    const left = Math.max(0, Math.floor((bounds.x - b.x) * metadata.width / b.width));
    const top = Math.max(0, Math.floor((bounds.y - b.y) * metadata.height / b.height));
    const right = Math.min(metadata.width, Math.ceil((bounds.x + bounds.width - b.x) * metadata.width / b.width));
    const bottom = Math.min(metadata.height, Math.ceil((bounds.y + bounds.height - b.y) * metadata.height / b.height));
    assert.ok(right > left && bottom > top);
    // Save only the owned rectangle, not the complete private monitor image.
    await sharp(bytes).extract({ left, top, width: right - left, height: bottom - top }).png().toFile(`${directory}/owned-${capture}-${route}.png`);
    routes.push({ capture, route, native_dimensions: { width: b.width, height: b.height }, overview_dimensions: { width: metadata.width, height: metadata.height },
      owned_crop_dimensions: { width: right - left, height: bottom - top }, read_only: true, selected_is_primary: route === "selected" });
  }
  assert.equal(site.events().length, 0, "Foreground setup must not click fixture controls.");
  success = true;
} catch (error) {
  await writeFile(`${directory}/private-failure.txt`, error.stack ?? String(error));
  console.error("Display visibility proof stopped; no input replay.");
} finally {
  clearTimeout(timer);
  const cleaned = await finishProfile(success, {
    fixture: async () => { assert.ok(fixture); const result = await fixture.close(); assert.ok(result.sourceGone && result.profileRemoved); },
    driver: async () => { await driver.close(); }, site: async () => { await site?.close(); },
    candidate_files: async () => { await rm(staged, { recursive: true, force: true }); },
  });
  assert.deepEqual(await readFile(configFile), originalConfig);
  assert.equal(hash(await readFile(config.command)), installedHash);
  const report = { schema: 1, success: cleaned.success, candidate_source: plan.candidate.source, candidate_sha256: plan.candidate.sha256,
    setup: "CUA bring_to_front and set_window_frame on one new owned fixture", control_input_count: 0, routes,
    visual_review: "pending actual owned-crop inspection", cleanup: cleaned.cleanup, config_unchanged: true };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, report: `${directory}/report.json` }));
  if (!cleaned.success) process.exitCode = 1;
}
