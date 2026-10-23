import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SETUP_SCRIPT = fileURLToPath(new URL("../scripts/setup.sh", import.meta.url));

/** Optional parts that scripts/setup.sh installs, for argument completion. */
export const SETUP_COMPONENTS: { name: string; description: string }[] = [
  { name: "browser", description: "Portable Windows Node for open_browser and attach_browser" },
  { name: "firefox", description: "Playwright's Firefox for open_browser" },
  { name: "perception", description: "Cua perception for the regions view (about 420 MB)" },
  { name: "mxc", description: "Microsoft MXC for isolated agent sessions" },
  { name: "vscode-bridge", description: "Pi Browser Bridge for VS Code's integrated browser" },
  { name: "machine", description: "Prepare another Windows machine over SSH" },
];

/** Split command arguments on spaces, keeping single- or double-quoted paths whole. */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}

/** Run the setup script; the whole output goes to a log file, the tail comes back for the notification. */
export async function runSetup(args: string[], cwd: string, script = SETUP_SCRIPT): Promise<{ code: number; tail: string; log: string }> {
  const log = path.join(await mkdtemp(path.join(tmpdir(), "pi-computer-setup-")), "setup.log");
  const file = createWriteStream(log);
  let tail = "";
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("bash", [script, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const take = (chunk: Buffer) => { file.write(chunk); tail = (tail + chunk.toString("utf8")).slice(-4000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", status => resolve(status ?? 1));
  });
  await new Promise(resolve => file.end(resolve));
  // Progress bars redraw with carriage returns; keep only the last state of each line.
  const lines = tail.split("\n").map(line => line.split("\r").at(-1)!.trimEnd()).filter(Boolean);
  return { code, tail: lines.slice(-15).join("\n"), log };
}

/** /computer-setup COMPONENT [local|MACHINE]: the user's own entry point to the optional installs. */
export function registerSetupCommand(pi: ExtensionAPI, script = SETUP_SCRIPT): void {
  pi.registerCommand("computer-setup", {
    description: "Install an optional computer-use part: browser, firefox, perception, mxc, vscode-bridge or machine",
    getArgumentCompletions: prefix => {
      if (/\s/.test(prefix.trimStart())) return null;
      const items = SETUP_COMPONENTS.filter(item => item.name.startsWith(prefix.trim()))
        .map(item => ({ value: item.name, label: item.name, description: item.description }));
      return items.length ? items : null;
    },
    handler: async (text, ctx) => {
      const args = splitArgs(text);
      if (!args.length) {
        const { tail } = await runSetup([], ctx.cwd, script);
        ctx.ui.notify(tail, "info");
        return;
      }
      ctx.ui.setStatus("computer-setup", `Computer setup: ${args[0]}…`);
      try {
        const { code, tail, log } = await runSetup(args, ctx.cwd, script);
        ctx.ui.notify(`${code === 0 ? "Computer setup finished" : `Computer setup failed (exit ${code})`}: ${args.join(" ")}\n${tail}\nFull log: ${log}`,
          code === 0 ? "info" : "error");
      } finally { ctx.ui.setStatus("computer-setup", undefined); }
    },
  });
}
