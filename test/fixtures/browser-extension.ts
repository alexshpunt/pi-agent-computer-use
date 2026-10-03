import { spawn } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "../../src/browser-client.ts";
import { registerBrowserTools } from "../../src/browser-tools.ts";

export default function browserFixture(pi: ExtensionAPI) {
  const client = new BrowserClient(async () => spawn(process.execPath,
    [path.join(import.meta.dirname,"browser-worker.ts"),path.join(process.cwd(),"browser-calls.jsonl")],
    {stdio:["pipe","pipe","pipe"]}));
  registerBrowserTools(pi,client);
}
