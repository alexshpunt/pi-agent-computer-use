import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVisionDebug } from "../../src/vision-debug.ts";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN2kAAAAASUVORK5CYII=";

/** Real-Pi Vision debug fixture: synthetic image tools, no native UI or browser. */
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
  createCodemodeExtension({ mode: "on" })(pi);
  const image = { type: "image" as const, data: PIXEL, mimeType: "image/png" };
  const imageTool = (name: string) => pi.registerTool({
    name, label: name, description: "Return one synthetic PNG.",
    outputSchema: Type.Object({ text: Type.String(), image: Type.Unknown() }, { additionalProperties: true }),
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      return { content: [{ type: "text" as const, text: "Synthetic image." }, image], details: { status: "observed" },
        structuredContent: { status: "observed", text: "Synthetic image.", image } };
    },
  });
  imageTool("computer_sample_open");
  imageTool("computer_sample_observe");
  // Stands in for Pi Agent IDE's read, which serves computer: paths alongside ordinary files.
  pi.registerTool({
    name: "read", label: "read", description: "Read a path; computer: paths return one synthetic PNG.",
    parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
    async execute(_id, params) {
      return params.path.startsWith("computer:")
        ? { content: [{ type: "text" as const, text: "Synthetic image." }, image], details: { status: "observed" } }
        : { content: [{ type: "text" as const, text: "plain file" }], details: { status: "read" } };
    },
  });
  pi.registerTool({
    name: "computer_sample_fail", label: "computer_sample_fail", description: "Always refuse.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() { return { content: [{ type: "text" as const, text: "Refused." }], details: { status: "refused" }, isError: true }; },
  });
  pi.registerTool({
    name: "computer_sample_close", label: "computer_sample_close", description: "Return text only.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() { return { content: [{ type: "text" as const, text: "Closed." }], details: { status: "closed" } }; },
  });
  pi.on("session_start", async (_event, ctx) => {
    await writeFile(path.join(ctx.cwd, "vision-url.txt"), debug.url() ?? "");
  });
  pi.on("agent_end", async (_event, ctx) => {
    await writeFile(path.join(ctx.cwd, "vision-trace.json"), JSON.stringify(debug.trace.snapshot()));
  });
}
