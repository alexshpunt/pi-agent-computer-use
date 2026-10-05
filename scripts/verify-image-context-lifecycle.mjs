import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerVisionDebug } from "../src/vision-debug.ts";

// Real public Pi SDK lifecycle and real HTTP serializer. No model account, native capture or machine settings.
const directory = path.resolve(".tmp/image-context/lifecycle");
await mkdir(directory, { recursive: true });
const cwd = await mkdtemp(path.join(directory, "session-"));
const agentDir = path.join(cwd, "agent"); await mkdir(agentDir);
const bodies = [];
const provider = createServer(async (request, response) => {
  let input = ""; for await (const chunk of request) input += chunk;
  bodies.push(JSON.parse(input));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write("data: " + JSON.stringify({ id: "lifecycle-" + bodies.length, object: "chat.completion.chunk", model: "fixture",
    choices: [{ index: 0, delta: { content: "Synthetic history checked. Continue the image retention check." }, finish_reason: "stop" }] }) + "\n\n");
  response.end("data: [DONE]\n\n");
});
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
  modelsStorePath: path.join(agentDir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
modelRuntime.registerProvider("lifecycle-loopback", { api: "openai-completions", baseUrl, apiKey: "synthetic",
  models: [{ id: "fixture", name: "Local image lifecycle", reasoning: false, input: ["text", "image"], contextWindow: 128000,
    maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
const model = modelRuntime.getModel("lifecycle-loopback", "fixture"); assert.ok(model);
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 5000 }, retry: { enabled: false }, cacheWarming: "off" });
let debug;
let session;
const records = [];
const extensionErrors = [];
const images = [];
const hash = data => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
const wireHashes = body => [...JSON.stringify(body).matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)].map(m => hash(m[1]));
const exists = p => stat(p).then(() => true, () => false);
const open = async manager => {
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => { debug = registerVisionDebug(pi); }] });
  await resourceLoader.reload();
  const created = await createAgentSession({ cwd, agentDir, resourceLoader, sessionManager: manager, settingsManager,
    modelRuntime, model, noTools: "all", thinkingLevel: "off" });
  session = created.session; await session.bindExtensions({ onError: error => extensionErrors.push(error) });
};
const check = phase => {
  const state = debug.trace.snapshot();
  const actual = wireHashes(bodies.at(-1));
  assert.deepEqual(extensionErrors, [], "No extension hook errors");
  assert.equal(state.requests.at(-1).imageCount, actual.length);
  assert.equal("imageContext" in state, false);
  assert.ok(state.frames.length <= 3);
  records.push({ phase, imageCount: actual.length, activeHashes: actual, viewerCards: state.frames.length });
};
try {
  await open(SessionManager.create(cwd, path.join(cwd, "sessions")));
  for (let n = 0; n < 12; n++) {
    const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: n * 10, g: 100, b: 50 } } }).png().toBuffer();
    images.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    await session.prompt(`User frame=${n}`, { images: [images[n]] }); check(`frame-${n}`);
  }
  assert.deepEqual(records.map(x => x.imageCount), Array.from({ length: 12 }, (_, n) => n + 1));
  const originalImageCount = () => session.sessionManager.getEntries().flatMap(e => e.type === "message" && Array.isArray(e.message.content) ? e.message.content : []).filter(b => b.type === "image").length;
  assert.equal(originalImageCount(), 12);
  const originalHashes = images.map(image => hash(image.data));
  assert.deepEqual(records.at(-1).activeHashes, originalHashes);
  assert.equal(await exists(path.join(cwd, ".tmp/computer-vision")), false);
  const originalPath = session.sessionFile; assert.ok(originalPath);
  await session.reload();
  await session.prompt("Check the restored original history after reload."); check("reload");
  assert.equal(originalImageCount(), 12);
  assert.deepEqual(records.at(-1).activeHashes, originalHashes, "Reload preserves every original image in model context");
  await session.compact("Keep the synthetic image test chronology. Do not invent screen contents.");
  assert.equal(session.sessionManager.getEntries().filter(e => e.type === "compaction").length, 1);
  assert.equal(originalImageCount(), 12, "Compaction keeps original history");
  await session.prompt("Check the real compacted context."); check("compact");
  assert.ok(session.messages.some(m => m.role === "compactionSummary"));
  const expected = records.at(-1).activeHashes;
  assert.ok(expected.length < 12, "Normal Pi compaction, not the extension, reduces old context");
  await session.reload(); await session.prompt("Check the compacted history after another reload."); check("compact-reload");
  assert.deepEqual(records.at(-1).activeHashes, expected);
  await session.abort();
  await debug.close(); session.dispose(); session = undefined;
  await open(SessionManager.open(originalPath));
  await session.prompt("Check a new Pi session restored from the saved compacted file."); check("reopen");
  assert.deepEqual(records.at(-1).activeHashes, expected);
  assert.equal(originalImageCount(), 12);
  await session.reload();
  assert.equal(await exists(path.join(cwd, ".tmp/computer-vision")), false, "No separate image archive is created");
  await writeFile(path.join(directory, "run.json"), JSON.stringify({ success: true, records, httpRequests: bodies.length,
    actualManualCompactions: 1, actualReloads: 3, fileReopens: 1, originalImagesPreserved: 12, separateArchiveCreated: false,
    usage: "Synthetic loopback responses; no billing or cache-speed claims", paidCalls: 0 }, null, 2) + "\n");
  console.log(JSON.stringify({ success: true, records: records.length, httpRequests: bodies.length, directory }));
} finally {
  if (session) { await session.abort(); await debug.close(); session.dispose(); }
  await new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); });
  await rm(cwd, { recursive: true, force: true });
}
