import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fixtureExtension from "./fake-extension.ts";

/** Real registration/session/MCP, with deterministic test-only WGC qualification. */
export default function persistentWgcFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  fixtureExtension(pi, true);
}
