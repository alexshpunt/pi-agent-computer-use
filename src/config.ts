import { readFile } from "node:fs/promises";
import path from "node:path";
import { findBundledRuntime, type BundledRuntime } from "./native-runtime.ts";

/** Trusted overrides and an internal verified bundle. No executable or per-window target comes from agent input. */
export interface ComputerConfig {
  command: string;
  args?: string[];
  interop?: string;
  runtime?: "windows-held-paths" | "windows-key-holds" | "windows-selected-displays" | "windows-capture-drag" | "windows-shell-desktops" | "windows-single-png" | "windows-semantic-actions" | "windows-fast-bilinear" | "windows-direct-process" | "windows-persistent-wgc" | "windows-native-pointer" | "windows-coordinate-scroll" | "windows-window-restore" | "windows-window-management" | "windows-desktop";
  bundled?: BundledRuntime;
  /** A sandbox guest's driver behind a host loopback relay. Set by the sandbox lifecycle, never read from config files. */
  endpoint?: GuestEndpoint;
  /** SSH alias when the driver runs on another machine. Set by connect, never read from config files. */
  ssh?: string;
  /** Machines an agent may connect to by name. */
  machines?: Record<string, MachineConfig>;
}

/** Another machine's WSL reached over SSH. Paths are on that machine; nothing here comes from agent input. */
export interface MachineConfig {
  /** OpenSSH alias; authentication and host trust stay in the user's SSH config. */
  ssh: string;
  /** Remote WSL path of cua-driver.exe. */
  command: string;
  runtime?: ComputerConfig["runtime"];
  /** Remote WSL path of Windows node.exe, needed for open_browser. */
  node?: string;
  /** Remote WSL path of a copy of this extension with playwright-core, needed for open_browser. */
  package?: string;
}

/** Host loopback ports that relay to one sandbox guest's driver and window identity peer. */
export interface GuestEndpoint {
  url: string;
  token: string;
  identityPort: number;
  /** Which kind of guest the driver runs in; a Windows Sandbox when omitted. */
  domain?: "windows-sandbox" | "windows-session";
}

const RUNTIMES = ["windows-held-paths", "windows-key-holds", "windows-selected-displays", "windows-capture-drag", "windows-shell-desktops", "windows-single-png", "windows-semantic-actions", "windows-fast-bilinear", "windows-direct-process", "windows-persistent-wgc", "windows-native-pointer", "windows-coordinate-scroll", "windows-window-restore", "windows-window-management", "windows-desktop"];

/** Read trusted overrides, otherwise select the native package installed with this extension. */
export async function loadComputerConfig(cwd: string): Promise<ComputerConfig> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(path.join(cwd, ".pi", "computer-use.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid .pi/computer-use.json; see docs/setup.md#override-the-runtime.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !["command", "args", "interop", "runtime", "machines"].includes(key))
    || (raw.command !== undefined && (typeof raw.command !== "string" || !raw.command))
    || (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(arg => typeof arg === "string")))
    || (raw.interop !== undefined && typeof raw.interop !== "string")
    || (raw.runtime !== undefined && (typeof raw.runtime !== "string" || !RUNTIMES.includes(raw.runtime)))
    || (raw.runtime !== undefined && (typeof raw.command !== "string" || raw.args !== undefined)))
    throw new Error("Invalid computer-use configuration. Remove the old target field: this extension uses YOLO session window references, not configured PID/HWND.");
  const command = raw.command as string | undefined ?? process.env.CUA_DRIVER_PATH;
  if (!command && raw.args !== undefined) throw new Error("Bundled runtimes use their pinned MCP arguments; set a trusted command to override arguments.");
  const bundled = command ? undefined : await findBundledRuntime(raw.interop as string | undefined);
  // The shipped runtime is the qualified windows-desktop build, so it gets that profile's capabilities.
  // A configured runtime always comes with its own trusted command.
  const runtime = (raw.runtime as ComputerConfig["runtime"]) ?? (bundled ? "windows-desktop" : undefined);
  return { command: command || bundled!.command,
    ...(bundled ? { bundled } : {}),
    ...(raw.args ? { args: raw.args as string[] } : {}), ...(raw.interop ? { interop: raw.interop as string } : {}),
    ...(runtime ? { runtime } : {}),
    ...(raw.machines !== undefined ? { machines: parseMachines(raw.machines) } : {}) };
}

/** The trusted file's interop socket and machines, without selecting or downloading a runtime. */
export async function readMachineSettings(cwd: string): Promise<{ interop?: string; machines: Record<string, MachineConfig> }> {
  let raw: unknown = {};
  try { raw = JSON.parse(await readFile(path.join(cwd, ".pi", "computer-use.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid .pi/computer-use.json; see docs/setup.md#override-the-runtime.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid .pi/computer-use.json; see docs/setup.md#override-the-runtime.");
  const { interop, machines } = raw as Record<string, unknown>;
  return { ...(typeof interop === "string" ? { interop } : {}), machines: machines === undefined ? {} : parseMachines(machines) };
}

function parseMachines(value: unknown): Record<string, MachineConfig> {
  const invalid = () => { throw new Error("Invalid machines in .pi/computer-use.json: use {\"<name>\": {\"ssh\", \"command\", \"runtime\"?, \"node\"?, \"package\"?}}."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const machines: Record<string, MachineConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    // "local" names this machine itself.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || name === "local" || !raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    const machine = raw as Record<string, unknown>;
    if (Object.keys(machine).some(key => !["ssh", "command", "runtime", "node", "package"].includes(key))
      || typeof machine.ssh !== "string" || typeof machine.command !== "string" || !machine.command.startsWith("/")
      || (machine.runtime !== undefined && !RUNTIMES.includes(machine.runtime as string))
      || [machine.node, machine.package].some(path => path !== undefined && (typeof path !== "string" || !path.startsWith("/")))) return invalid();
    machines[name] = machine as unknown as MachineConfig;
  }
  return machines;
}
