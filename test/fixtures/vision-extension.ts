import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import browserFixture from "./browser-extension.ts";
import { registerVisionDebug } from "../../src/vision-debug.ts";

export default function visionFixture(pi: ExtensionAPI): void {
  const baseUrl = process.env.VISION_TEST_PROVIDER;
  if (baseUrl) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl)) throw new Error("Fixture provider must be loopback.");
    pi.registerProvider("vision-loopback", {
      baseUrl, api: "openai-completions", apiKey: "synthetic-test-key",
      models: [{ id: "fixture", name: "Vision loopback fixture", reasoning: false, input: ["text", "image"],
        contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
  }
  const debug = registerVisionDebug(pi);
  browserFixture(pi);
  pi.on("session_start", async (_event, ctx) => {
    await writeFile(path.join(ctx.cwd, "vision-url.txt"), debug.url() ?? "");
  });
  pi.on("agent_end", async (_event, ctx) => {
    await writeFile(path.join(ctx.cwd, "vision-trace.json"), JSON.stringify(debug.trace.snapshot()));
  });
}
