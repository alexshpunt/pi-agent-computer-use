import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fixtureExtension from "./fake-extension.ts";

// Seed a trusted saved user choice before production session_start restores it.
// This exercises real Pi restoration and schemas, not interactive command input.
export default function safeFixture(pi: ExtensionAPI): void {
  pi.on("session_start", () => { pi.appendEntry("computer-use-mode", { mode: "safe" }); });
  fixtureExtension(pi);
}
