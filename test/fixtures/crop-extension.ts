import { spawn } from "node:child_process";
import path from "node:path";
import sharp from "sharp";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "../../src/browser-client.ts";
import { registerBrowserTools } from "../../src/browser-tools.ts";
import { registerVisionDebug } from "../../src/vision-debug.ts";
import { VisionImages } from "../../src/vision-images.ts";
import { writeFile } from "node:fs/promises";

export default async function cropFixture(pi: ExtensionAPI): Promise<void> {
  createCodemodeExtension({ mode: "on" })(pi);
  const images = new VisionImages(); const debug = registerVisionDebug(pi, images);
  const source = path.join(process.cwd(), "original.png");
  await sharp(Buffer.from('<svg width="1200" height="600"><rect width="1200" height="600" fill="white"/><text x="130" y="85" font-size="12">Original detail 825</text></svg>')).png().toFile(source);
  registerBrowserTools(pi, new BrowserClient(async () => spawn(process.execPath,
    [path.join(import.meta.dirname, "crop-worker.ts"), source, path.join(process.cwd(), "crop-calls.jsonl")],
    { stdio: ["pipe", "pipe", "pipe"] }), images));
  pi.on("agent_end", async () => { await writeFile(path.join(process.cwd(), "crop-trace.json"), JSON.stringify(debug.trace.snapshot())); });
}
