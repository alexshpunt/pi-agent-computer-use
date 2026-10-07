import assert from "node:assert/strict";
import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { createWindowActionsSite } from "../test/fixtures/window-actions-site.mjs";

// Opt-in fixture setup only. Production computer_* tools perform the measured input.
// Keep this runner alive until finish; never change workspace with its fixtures open.
assert.equal(process.argv[2], "--live-approved", "Owner approval is required for disposable live windows.");
const config = await loadComputerConfig(process.cwd());
assert.ok(["windows-selected-displays", "windows-capture-drag"].includes(config.runtime), "Use a separately qualified selected-display runtime.");
const directory = `.tmp/lpt-619/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const driver = new McpDriver(config);
const nativeRoot = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const site = await createWindowActionsSite();
const fixtures = [];
const call = async (name, args) => {
  const result = await driver.call(name, args);
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`);
  return result;
};
const save = async () => writeFile(`${directory}/events.json`, JSON.stringify(site.state(), null, 2));
const setFrame = async (index, frame) => {
  const fixture = fixtures[index];
  await call("set_window_frame", { ...fixture.target, ...frame });
  fixture.frame = frame;
  await delay(400);
  const listed = await call("list_windows", {});
  const matches = listed.structuredContent.windows.filter(window => window.pid === fixture.target.pid && window.window_id === fixture.target.window_id);
  assert.equal(matches.length, 1, "Frame readback must identify the same owned window.");
  console.log(JSON.stringify({ fixture: index + 1, bounds: matches[0].bounds, input_authority: "discovery does not replace a production overview" }));
};
try {
  const discovered = await call("list_displays", {});
  const monitors = discovered.structuredContent.displays;
  assert.equal(monitors.length, 2, "Use the two existing monitors; never change topology.");
  for (const [index, monitor] of monitors.entries()) {
    const fixture = await openCompleteInputWindow(driver, `${site.url}/${index}`, nativeRoot);
    fixture.frame = { x: monitor.bounds.x + 80, y: monitor.bounds.y + 80, width: 900, height: 900 };
    fixtures.push(fixture);
    await call("set_window_frame", { ...fixture.target, ...fixture.frame });
    await delay(400);
    const view = await call("get_window_state", { ...fixture.target, max_image_dimension: 500 });
    await writeFile(`${directory}/window-${index + 1}.json`, JSON.stringify(view.structuredContent, null, 2));
    const png = view.content.find(block => block.type === "image");
    if (png) await writeFile(`${directory}/window-${index + 1}.png`, Buffer.from(png.data, "base64"));
  }
  const manifest = { directory, url: site.url, runtime: config.runtime,
    fixtures: fixtures.map((fixture, index) => ({ title: `Pi window actions fixture ${index + 1}`, target: fixture.target, frame: fixture.frame, display: monitors[index], profile: fixture.profile })) };
  await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
  await save();
  console.log(JSON.stringify({ directory, url: site.url, titles: manifest.fixtures.map(f => f.title) }));
  console.log("Production fixtures ready. Commands: state, grow1, restore1, move1, finish. Native setup does not ground production input.");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line.trim() === "finish") break;
    if (line.trim() === "state") { await save(); console.log(JSON.stringify(site.state())); }
    else if (line.trim() === "grow1") await setFrame(0, { ...fixtures[0].frame, width: 1200 });
    else if (line.trim() === "restore1") await setFrame(0, { ...fixtures[0].frame, width: 900 });
    else if (line.trim() === "move1") {
      const primary = monitors.find(monitor => monitor.primary);
      assert.ok(primary, "Native discovery must identify the existing primary monitor.");
      await setFrame(0, { ...fixtures[0].frame, x: primary.bounds.x + 1100, y: primary.bounds.y + 80 });
    }
    else console.log("Unknown fixture command; no action.");
  }
  input.close();
} finally {
  await save();
  const cleanup = [];
  try { for (const fixture of fixtures.reverse()) cleanup.push(await fixture.close()); }
  finally { await driver.close(); await site.close(); }
  await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
}
