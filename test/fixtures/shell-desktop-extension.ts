import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fixtureExtension from "./fake-extension.ts";

/** Exercise production registration, resources and MCP; substitute only native window lifetime identity. */
export default function shellDesktopFixture(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  fixtureExtension(pi);
}
