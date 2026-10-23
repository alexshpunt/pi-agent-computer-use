import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SETUP_PARTS, runSetup, type SetupPart, type SetupRequest } from "./setup.ts";

/** Split command arguments on spaces, keeping single- or double-quoted paths whole. */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) args.push(match[1] ?? match[2] ?? match[3]);
  return args;
}

export const SETUP_USAGE = ["Usage: /computer-setup PART [local|MACHINE]", "",
  ...SETUP_PARTS.flatMap(part => [part.name === "machine" ? "machine SSH_ALIAS [NAME]" : part.name === "vscode-bridge" ? "vscode-bridge [MACHINE] [CODE_CMD ARGV_JSON]" : part.name, `  ${part.description}`]),
  "", "Everything goes into the Windows user's own folders; downloads are checked against pinned SHA-256 sums."].join("\n");

/** Turn command words into a request; undefined shows the usage. */
export function parseSetupArgs(args: string[]): SetupRequest | undefined {
  const [part, ...rest] = args;
  if (!part || !SETUP_PARTS.some(item => item.name === part)) return undefined;
  if (part === "machine") return rest.length >= 1 && rest.length <= 2 ? { part, ssh: rest[0], ...(rest[1] ? { name: rest[1] } : {}) } : undefined;
  if (part === "vscode-bridge") {
    if (rest.length > 3) return undefined;
    const machine = rest.length % 2 === 1 ? rest[0] : undefined;
    const paths = machine === undefined ? rest : rest.slice(1);
    return { part, ...(machine ? { machine } : {}), ...(paths.length ? { code: paths[0], argv: paths[1] } : {}) };
  }
  return rest.length <= 1 ? { part: part as SetupPart, ...(rest[0] ? { machine: rest[0] } : {}) } : undefined;
}

/** /computer-setup PART [local|MACHINE]: the user's own entry point to the optional installs. */
export function registerSetupCommand(pi: ExtensionAPI, run: typeof runSetup = runSetup): void {
  pi.registerCommand("computer-setup", {
    description: "Install an optional computer-use part: browser, firefox, perception, mxc, vscode-bridge or machine",
    getArgumentCompletions: prefix => {
      if (/\s/.test(prefix.trimStart())) return null;
      const items = SETUP_PARTS.filter(item => item.name.startsWith(prefix.trim()))
        .map(item => ({ value: item.name, label: item.name, description: item.description }));
      return items.length ? items : null;
    },
    handler: async (text, ctx) => {
      const request = parseSetupArgs(splitArgs(text));
      if (!request) { ctx.ui.notify(SETUP_USAGE, text.trim() ? "error" : "info"); return; }
      const label = `Computer setup: ${request.part}`;
      ctx.ui.setStatus("computer-setup", `${label}…`);
      try {
        const result = await run(request, ctx.cwd, { progress: step => ctx.ui.setStatus("computer-setup", `${label}: ${step}…`) });
        ctx.ui.notify(result, "info");
      } catch (error) {
        ctx.ui.notify(`${label} failed: ${error instanceof Error ? error.message : error}`, "error");
      } finally { ctx.ui.setStatus("computer-setup", undefined); }
    },
  });
}
