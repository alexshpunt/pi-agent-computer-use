import { readFile } from "node:fs/promises";
import path from "node:path";
import { findBundledRuntime, type BundledRuntime } from "./native-runtime.ts";

/** Trusted overrides and an internal verified bundle. No executable or per-window target comes from agent input. */
export interface ComputerConfig {
  command: string;
  args?: string[];
  interop?: string;
  runtime?: "windows-held-paths" | "windows-key-holds" | "windows-selected-displays" | "windows-capture-drag" | "windows-shell-desktops" | "windows-single-png" | "windows-semantic-actions" | "windows-fast-bilinear" | "windows-direct-process" | "windows-persistent-wgc" | "windows-native-pointer";
  bundled?: BundledRuntime;
}

/** Read trusted overrides, otherwise select the native package installed with this extension. */
export async function loadComputerConfig(cwd: string): Promise<ComputerConfig> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(path.join(cwd, ".pi", "computer-use.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid .pi/computer-use.json; use the optional environment-only config in docs/standalone-poc.md.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !["command", "args", "interop", "runtime"].includes(key))
    || (raw.command !== undefined && (typeof raw.command !== "string" || !raw.command))
    || (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(arg => typeof arg === "string")))
    || (raw.interop !== undefined && typeof raw.interop !== "string")
    || (raw.runtime !== undefined && (typeof raw.runtime !== "string" || !["windows-held-paths", "windows-key-holds", "windows-selected-displays", "windows-capture-drag", "windows-shell-desktops", "windows-single-png", "windows-semantic-actions", "windows-fast-bilinear", "windows-direct-process", "windows-persistent-wgc", "windows-native-pointer"].includes(raw.runtime)))
    || (raw.runtime !== undefined && (typeof raw.command !== "string" || raw.args !== undefined)))
    throw new Error("Invalid computer-use configuration. Remove the old target field: this extension uses YOLO session window references, not configured PID/HWND.");
  const command = raw.command as string | undefined ?? process.env.CUA_DRIVER_PATH;
  if (!command && raw.args !== undefined) throw new Error("Bundled runtimes use their pinned MCP arguments; set a trusted command to override arguments.");
  const bundled = command ? undefined : await findBundledRuntime(raw.interop as string | undefined);
  return { command: command ?? bundled!.command,
    ...(bundled ? { bundled } : {}),
    ...(raw.args ? { args: raw.args as string[] } : {}), ...(raw.interop ? { interop: raw.interop as string } : {}),
    ...(raw.runtime ? { runtime: raw.runtime as ComputerConfig["runtime"] } : {}) };
}
