import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "../../src/browser-client.ts";
import { registerBrowserTools } from "../../src/browser-tools.ts";
import { registerVisionDebug } from "../../src/vision-debug.ts";
import { VisionImages } from "../../src/vision-images.ts";

export default async function sizeFixture(pi: ExtensionAPI): Promise<void> {
  const baseUrl = process.env.VISION_TEST_PROVIDER!;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl)) throw new Error("Expected loopback fixture.");
  pi.registerProvider("vision-size", {
    baseUrl, api: "openai-completions", apiKey: "synthetic-fixture",
    models: [{ id: "fixture", name: "Size contract", reasoning: false, input: ["text", "image"], contextWindow: 128000,
      maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  });
  createCodemodeExtension({ mode: "on" })(pi);
  const images = new VisionImages();
  const debug = registerVisionDebug(pi, images);
  const source = path.join(process.cwd(), "original.png");
  await sharp(Buffer.from('<svg width="1200" height="600"><rect width="1200" height="600" fill="white"/><text x="20" y="40" font-size="24">Synthetic pixel-size contract</text></svg>')).png().toFile(source);
  const browser = new BrowserClient(async () => spawn(process.execPath,
    [path.join(import.meta.dirname, "vision-size-worker.ts"), source, path.join(process.cwd(), "inputs.jsonl")],
    { stdio: ["pipe", "pipe", "pipe"] }), images);
  registerBrowserTools(pi, browser);
  pi.on("session_start", async (_event, ctx) => { await writeFile(path.join(ctx.cwd, "viewer-url.txt"), debug.url()!); });
  pi.on("agent_end", async (_event, ctx) => { await writeFile(path.join(ctx.cwd, "trace.json"), JSON.stringify(debug.trace.snapshot())); });
}
