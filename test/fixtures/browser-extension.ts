import { spawn } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "../../src/browser-client.ts";
import { registerBrowserTools } from "../../src/browser-tools.ts";

export default function browserFixture(pi: ExtensionAPI) {
  createCodemodeExtension({ mode: "on" })(pi);
  // Trusted fixture seed stands for a hint checkpoint from a previous extension load.
  pi.on("session_start", () => { pi.appendEntry("browser-hint-offset", { offset: 26 }); });
  const client = new BrowserClient(async () => spawn(process.execPath,
    [path.join(import.meta.dirname,"browser-worker.ts"),path.join(process.cwd(),"browser-calls.jsonl")],
    {stdio:["pipe","pipe","pipe"]}));
  registerBrowserTools(pi,client);
}
