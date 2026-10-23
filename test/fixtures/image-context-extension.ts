import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Type } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVisionDebug } from "../../src/vision-debug.ts";

export default function imageContextFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  const baseUrl = process.env.VISION_TEST_PROVIDER;
  if (!baseUrl || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl)) throw Error("Fixture provider must be loopback");
  pi.registerProvider("image-loopback", { baseUrl, api: "openai-completions", apiKey: "synthetic",
    models: [{ id: "fixture", name: "Image context fixture", reasoning: false, input: ["text", "image"], contextWindow: 128000,
      maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const debug = registerVisionDebug(pi);
  pi.registerTool({ name: "computer_sample", label: "Synthetic frame", description: "Generate one synthetic fixture image, not a desktop capture.",
    parameters: Type.Object({ n: Type.Integer({ minimum: 0, maximum: 20 }) }),
    outputSchema: Type.Object({ image: Type.Unknown() }),
    async execute(_id, { n }) {
      const source = sharp({ create: { width: 16, height: 12, channels: 3, background: { r: n * 10, g: 100, b: 50 } } });
      const bytes = await (n % 2 ? source.extract({ left: 0, top: 0, width: 8, height: 6 }).jpeg() : source.png()).toBuffer();
      const image = { type: "image" as const, data: bytes.toString("base64"), mimeType: n % 2 ? "image/jpeg" : "image/png" };
      return { content: [{ type: "text", text: `Frame ${n} ${n % 2 ? "detail" : "overview"}` }, image], details: { n }, structuredContent: { image } };
    } });
  pi.on("session_start", async (_event, ctx) => { await writeFile(path.join(ctx.cwd, "vision-url.txt"), debug.url() ?? ""); });
  pi.on("agent_end", async (_event, ctx) => { await writeFile(path.join(ctx.cwd, "vision-trace.json"), JSON.stringify(debug.trace.snapshot())); });
}
