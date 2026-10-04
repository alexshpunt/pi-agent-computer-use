import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUse from "../../src/index.ts";

/** Real-model qualification uses the production entry and native runtime unchanged. */
export default function nativeCua(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
  computerUse(pi);
}
