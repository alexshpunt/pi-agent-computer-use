import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";

// Verify owner-assisted window cleanup before deleting only the two recorded isolated profiles.
assert.equal(process.argv[2], "--cleanup-approved", "Explicit task cleanup is required.");
const file = process.argv[3];
assert.match(file ?? "", /^\.tmp\/lpt-625\/live-\d+\/manifest\.json$/);
const manifest = JSON.parse(await readFile(file, "utf8"));
assert.deepEqual(manifest.windows.map(w => w.title), ["Pi background capture target", "Pi background capture sentinel"]);
const driver = new McpDriver(await loadComputerConfig(process.cwd()));
const receipt = { cleanup_method: "owner-assisted, with grounded empty-Notepad tab close", windows_gone: false, profiles: [] };
try {
  const result = await driver.call("list_windows", {});
  assert.ok(!result.isError && Array.isArray(result.structuredContent?.windows), "Native cleanup readback failed.");
  const targets = [manifest.notepad.target, ...manifest.windows.map(w => w.target)];
  assert.ok(!result.structuredContent.windows.some(w => targets.some(t => t.pid === w.pid && t.window_id === w.window_id)), "A task window still exists; no profiles were removed.");
  receipt.windows_gone = true;
  for (const window of manifest.windows) {
    assert.match(window.profile, /^C:\\Users\\[^\n]+\\PiComputerUsePoC\\[^\n]+\\\.tmp\\cua-gestures-\d+$/);
    const path = window.profile.replace("C:\\", "/mnt/c/").replaceAll("\\", "/");
    await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await assert.rejects(readFile(path), error => error.code === "ENOENT");
    receipt.profiles.push({ profile: window.profile, removed: true });
  }
  await writeFile(`${dirname(file)}/cleanup-owner-assisted.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally { await driver.close(); }
