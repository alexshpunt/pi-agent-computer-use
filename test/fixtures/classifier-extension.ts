import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { registerClassifierTool } from "../../src/classifier-tool.ts";
import { VisualClassifier } from "../../src/visual-classifier.ts";
import { fileURLToPath } from "node:url";

/** Deterministic transport/branching peer; this does not establish model recognition. */
export default function classifierFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  const close = registerClassifierTool(pi, async () => new VisualClassifier(
    { python: process.execPath, model: "fixture" },
    fileURLToPath(new URL("./visual-classifier-worker.mjs", import.meta.url))));
  pi.registerTool({ name: "close_fixture_classifier", label: "Close fixture classifier", description: "Release the owned fixture worker.",
    parameters: Type.Object({}), async execute() { await close(); return { content: [{type:"text",text:"Closed"}],details:{} }; } });
  pi.on("session_shutdown", close);
}
