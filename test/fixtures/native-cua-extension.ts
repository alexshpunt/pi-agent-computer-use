import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUse from "../../src/index.ts";

/** Real-model qualification uses the production entry and native runtime unchanged. */
export default async function nativeCua(pi: ExtensionAPI): Promise<void> {
  createCodemodeExtension({ mode: "on" })(pi);
  await computerUse(pi);
}
