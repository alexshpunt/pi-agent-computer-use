import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Turn Codemode on in a real Pi run, so a test can call the computer tools from a script. */
export default function codemode(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: "on" })(pi);
}
