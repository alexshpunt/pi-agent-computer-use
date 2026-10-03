import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../src/index.ts";

/** Isolated SDK test loader: use Pi's real Codemode and the real owned browser tools. */
export default function nativeBrowser(pi: ExtensionAPI) {
  createCodemodeExtension({ mode: "on" })(pi);
  extension(pi);
}
