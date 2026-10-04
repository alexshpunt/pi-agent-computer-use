import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fixtureExtension from "./fake-extension.ts";

/** Use Pi's existing executor around the real desktop registration and deterministic MCP peer. */
export default function displayFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  fixtureExtension(pi);
}
