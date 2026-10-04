import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { ComputerSession } from "../src/session.ts";
import { CuaImageSettings } from "../src/cua-image-settings.ts";

// Trusted native contract probe, not a way for the agent to promote its interactive policy.
if (!process.argv.includes("--allow-primary-display")) throw new Error("Explicit primary-display read permission is required.");
const directory = ".tmp/display-observation/native";
await mkdir(directory, { recursive: true });
const backend = new McpDriver(await loadComputerConfig(process.cwd()));
const images = new CuaImageSettings();
let mode = "safe";
let revokeAfterCapture = false;
const nativeCalls = [];
let nativeImage;
const driver = {
  async call(name, args, signal) {
    nativeCalls.push({ name, args });
    const result = await backend.call(name, args, signal);
    nativeImage = result.content.find(block => block.type === "image");
    if (revokeAfterCapture) mode = "safe";
    return result;
  },
  identity: (...args) => backend.identity(...args), close: () => backend.close(),
};
const session = new ComputerSession(driver, () => mode, () => images.settings());
const records = [];
try {
  assert.equal((await session.observeDisplay("primary")).details.status, "refused");
  assert.equal(nativeCalls.length, 0);
  mode = "yolo";
  assert.equal((await session.observeDisplay("secondary")).details.status, "refused");
  assert.equal(nativeCalls.length, 0);
  for (const scale of [1, 0.5]) {
    if (scale !== 1) images.update({ kernel: "lanczos3", maxLongEdge: 500, scale });
    const result = await session.observeDisplay("primary");
    assert.equal(result.details.status, "observed");
    const image = result.content.find(block => block.type === "image");
    assert.deepEqual(image, nativeImage);
    const bytes = Buffer.from(image.data, "base64");
    assert.equal(bytes.readUInt32BE(16), result.details.source.image.dimensions.width);
    assert.equal(bytes.readUInt32BE(20), result.details.source.image.dimensions.height);
    assert.equal(result.details.source.capabilities.input, "none");
    assert.ok(Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20)) <= Math.floor(500 * scale));
    // Only ignored artifacts retain private full-display pixels.
    await writeFile(`${directory}/display-${scale}.png`, bytes);
    records.push({ scale, source: result.details.source, output: result.details.agent_image.output });
  }
  revokeAfterCapture = true;
  const revoked = await session.observeDisplay("primary");
  assert.equal(revoked.details.status, "refused");
  assert.equal(revoked.content.filter(block => block.type === "image").length, 0);
  assert.equal(revoked.details.source, undefined);
  assert.equal(nativeCalls.length, 3);
  await writeFile(`${directory}/run.json`, JSON.stringify({ success: true, nativeCalls, records,
    policy: "trusted fixture state, not interactive user command", safeBeforeCaptureCalls: 0, revokedPixelsPublished: 0 }, null, 2));
  console.log(JSON.stringify({ success: true, nativeCalls: nativeCalls.length, directory, safeBeforeCaptureCalls: 0, revokedPixelsPublished: 0 }));
} finally { await session.close(); }
