import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import selectedDisplayFixture from "./selected-display-extension.ts";

// Restore an isolated trusted user choice, not a model permission toggle.
export default function selectedDisplaySafeFixture(pi: ExtensionAPI): void {
  pi.on("session_start", () => { pi.appendEntry("computer-use-mode", { mode: "safe" }); });
  selectedDisplayFixture(pi);
}
