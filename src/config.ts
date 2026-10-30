import { readFile } from "node:fs/promises";
import path from "node:path";
import { findBundledRuntime, type BundledRuntime } from "./native-runtime.ts";
import { ADDRESS_KINDS } from "./computer-address.ts";
import { liveInterop } from "./wsl-interop.ts";
import type { RelayCredentials } from "./relay-auth.ts";

/** Trusted overrides and an internal verified bundle. No executable or per-window target comes from agent input. */
export interface ComputerConfig {
  command: string;
  args?: string[];
  interop?: string;
  runtime?: "windows-held-paths" | "windows-key-holds" | "windows-selected-displays" | "windows-capture-drag" | "windows-shell-desktops" | "windows-single-png" | "windows-semantic-actions" | "windows-fast-bilinear" | "windows-direct-process" | "windows-persistent-wgc" | "windows-native-pointer" | "windows-coordinate-scroll" | "windows-window-restore" | "windows-window-management" | "windows-desktop";
  bundled?: BundledRuntime;
  /** Explicitly trusted experimental driver, with protocol checks instead of packaged-byte checks. */
  driverOverride?: true;
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
  /** Trusted remote driver override; omitted for the package-managed runtime. */
  command?: string;
  /** Keep a managed-looking path as an explicit test override. */
  driverOverride?: true;
  runtime?: ComputerConfig["runtime"];
  /** Remote WSL path of Windows node.exe, needed for open_browser. */
  node?: string;
  /** Remote WSL path of a copy of this extension with playwright-core, needed for open_browser. */
  package?: string;
  /** Keep a legacy managed-looking browser path as an explicit test override. */
  browserOverride?: true;
}

/** Host loopback ports that relay to one sandbox guest's driver and window identity peer. */
export interface GuestEndpoint {
  url: string;
  token: string;
  identityPort: number;
  /** Authenticates the reverse relay before driver/identity application bytes. Never read from user config. */
  relay?: RelayCredentials;
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
    || Object.keys(raw).some(key => !["command", "args", "interop", "runtime", "machines", "driverOverride"].includes(key))
    || (raw.driverOverride !== undefined && raw.driverOverride !== true)
    || (raw.driverOverride === true && typeof raw.command !== "string")
    || (raw.command !== undefined && (typeof raw.command !== "string" || !raw.command))
    || (raw.args !== undefined && (!Array.isArray(raw.args) || !raw.args.every(arg => typeof arg === "string")))
    || (raw.interop !== undefined && typeof raw.interop !== "string")
    || (raw.runtime !== undefined && (typeof raw.runtime !== "string" || !RUNTIMES.includes(raw.runtime)))
    || (raw.runtime !== undefined && (typeof raw.command !== "string" || raw.args !== undefined)))
    throw new Error("Invalid computer-use configuration. Remove the old target field: this extension uses YOLO session window references, not configured PID/HWND.");
  // Older setup wrote its managed, versioned desktop runtime into config. Treat that generated path as a default,
  // not a permanent override. A custom path, an environment override, or driverOverride: true stays explicit.
  const configured = raw.command as string | undefined;
  const legacyManaged = raw.driverOverride !== true && raw.runtime === "windows-desktop" && !!configured && isLegacyManagedDriver(configured);
  const command = legacyManaged ? process.env.CUA_DRIVER_PATH : configured ?? process.env.CUA_DRIVER_PATH;
  if (!command && raw.args !== undefined) throw new Error("Bundled runtimes use their pinned MCP arguments; set a trusted command to override arguments.");
  // A configured socket is used as given; otherwise a live one, since WSL_INTEROP can outlive its WSL session.
  const interop = raw.interop as string | undefined ?? await liveInterop();
  const bundled = command ? undefined : await findBundledRuntime(interop);
  // The shipped runtime is the qualified windows-desktop build, so it gets that profile's capabilities.
  // A configured runtime always comes with its own trusted command.
  const runtime = legacyManaged && !command ? "windows-desktop" : (raw.runtime as ComputerConfig["runtime"]) ?? (bundled ? "windows-desktop" : undefined);
  return { command: command || bundled!.command,
    ...(bundled ? { bundled } : {}),
    ...(raw.args ? { args: raw.args as string[] } : {}), ...(interop ? { interop } : {}),
    ...(runtime ? { runtime } : {}), ...(raw.driverOverride === true ? { driverOverride: true as const } : {}),
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
  const { interop: configured, machines } = raw as Record<string, unknown>;
  const interop = typeof configured === "string" ? configured : await liveInterop();
  return { ...(interop ? { interop } : {}), machines: machines === undefined ? {} : parseMachines(machines) };
}

/** Paths emitted by the old setup command are package-managed defaults, not permanent user overrides. */
function isLegacyManagedDriver(command: string): boolean {
  return /[\\/]Programs[\\/]PiComputerUse(?:PoC)?[\\/]cua-driver-\d+\.\d+\.\d+-[0-9a-f]{8}[\\/]runtime[\\/]cua-driver\.exe$/i.test(command);
}
function parseMachines(value: unknown): Record<string, MachineConfig> {
  const invalid = () => { throw new Error("Invalid machines in .pi/computer-use.json: use {\"<name>\": {\"ssh\", \"command\", \"runtime\"?, \"node\"?, \"package\"?}}."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const machines: Record<string, MachineConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    // "local" names this machine itself.
    // Short addresses start with the machine name (computer:<name>/w3qk), so it never takes an address kind word.
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || name === "local" || ADDRESS_KINDS.has(name) || !raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    const machine = raw as Record<string, unknown>;
    if (Object.keys(machine).some(key => !["ssh", "command", "runtime", "node", "package", "driverOverride", "browserOverride"].includes(key))
      || typeof machine.ssh !== "string" || !machine.ssh
      || (machine.command !== undefined && (typeof machine.command !== "string" || !machine.command.startsWith("/")))
      || (machine.driverOverride !== undefined && (machine.driverOverride !== true || !machine.command))
      || (machine.browserOverride !== undefined && (machine.browserOverride !== true || (!machine.node && !machine.package)))
      || (machine.runtime !== undefined && (!machine.command || !RUNTIMES.includes(machine.runtime as string)))
      || [machine.node, machine.package].some(path => path !== undefined && (typeof path !== "string" || !path.startsWith("/")))) return invalid();
    const legacy = machine.driverOverride !== true && machine.runtime === "windows-desktop" && typeof machine.command === "string" && isLegacyManagedDriver(machine.command);
    const { command, runtime, node, package: worker, ...rest } = machine;
    const keepNode = typeof node === "string" && (machine.browserOverride === true || !/[\\/]Programs[\\/]PiComputerUse[\\/]node-v[^/\\]+[\\/]node\.exe$/i.test(node));
    const keepWorker = typeof worker === "string" && (machine.browserOverride === true || !/\/\.local\/share\/pi-computer-use\/package$/.test(worker));
    machines[name] = { ...rest, ...(!legacy && command ? { command } : {}), ...(!legacy && runtime ? { runtime } : {}),
      ...(keepNode ? { node } : {}), ...(keepWorker ? { package: worker } : {}) } as unknown as MachineConfig;
  }
  return machines;
}
