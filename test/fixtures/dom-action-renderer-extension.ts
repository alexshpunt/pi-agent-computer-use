import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fixture from "./dom-actions-extension.ts";

/** Resolve the scripted source placeholder through the existing real ordinary-IDE fixture. */
export default async function rendererFixture(pi: ExtensionAPI): Promise<void> {
  await fixture(pi);
  let source: { path: string; hint: string } | undefined;
  pi.on("tool_result", event => {
    if (event.toolName !== "prepare_dom_action_source" || event.isError) return;
    const body = event.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    source = JSON.parse(body.slice(body.indexOf("{")).split("\n", 1)[0]) as { path: string; hint: string };
  });
  pi.on("tool_call", event => {
    if (event.toolName !== "insert" || event.input.path !== "computer:observation/renderer-fixture") return;
    if (!source) throw Error("The renderer test has not prepared its current DOM source");
    event.input.path = source.path;
    const command = JSON.parse(String(event.input.text));
    command.source_hint = source.hint;
    event.input.text = JSON.stringify(command);
    source = undefined;
  });
}
