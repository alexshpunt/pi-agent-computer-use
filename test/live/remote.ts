import { computerSource } from "../../src/computer-address.ts";
import type { ComputerAddress } from "../../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../../src/computer-resources.ts";
import { CuaImageSettings } from "../../src/cua-image-settings.ts";
import { machineFactory } from "../../src/machine.ts";
import type { ComputerResult } from "../../src/session.ts";

/**
 * Connect to the machine named by LIVE_MACHINE (default zinpc) through the same factory the extension uses.
 * Live checks act on that machine's real desktop: use only new Notepad/Paint documents and synthetic pages.
 */
export async function connectLive(cwd = process.cwd()) {
  const name = process.env.LIVE_MACHINE ?? "zinpc";
  const images = new CuaImageSettings(() => "bilinear");
  const resources = new ComputerResources(async () => { throw new Error("Live checks use only the remote machine."); },
    async () => ({ content: [], details: { status: "closed", mode: "yolo" } }), undefined,
    machineFactory({ getMode: () => "yolo", settings: () => images.settings() }));
  const connected = await resources.perform(at("computer:session"), cwd, JSON.stringify({ action: "connect", machine: name }), "insert");
  const machine = computerSource("machine", connected.details.machine_ref!);
  return {
    resources, machine, cwd,
    read: (path: string, views?: string[]) => resources.read(at(path), cwd, views) as Promise<ComputerResult>,
    search: (path: string, query: string) => resources.search(at(path), cwd, query),
    insert: (path: string, command: unknown) => resources.perform(at(path), cwd, JSON.stringify(command), "insert"),
    write: (path: string, text: string) => resources.perform(at(path), cwd, text, "write"),
    close: () => resources.perform(at("computer:session"), cwd, JSON.stringify({ action: "close" }), "insert").catch(() => undefined),
  };
}

export const at = (path: string): ComputerAddress => requireComputerAddress(path);
export const text = (result: ComputerResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
/** Window or display addresses listed by a discovery result. */
export function addresses(result: ComputerResult, kind: "window" | "display"): string[] {
  const rows = (result.details.state?.[kind === "window" ? "windows" : "displays"] ?? []) as Record<string, unknown>[];
  return rows.map(row => row[kind === "window" ? "window_ref" : "display_ref"]).filter((ref): ref is string => typeof ref === "string")
    .map(ref => computerSource(kind, ref));
}
