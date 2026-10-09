import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Content, Driver, DriverResult, WindowTarget } from "./session.ts";

import type { ComputerConfig } from "./config.ts";
import { WindowIdentity } from "./window-identity.ts";
import { verifyBundledRuntime } from "./native-runtime.ts";
import type { NativePlatform } from "./observation-source.ts";

/** Exact Windows CI artifact qualified for held paths; selection is trusted config, never a tool argument. */
export const HELD_PATH_RUNTIME = {
  source: "bba07a9c8ccba117c1057a3a0003e95d3693b2b3", version: "0.34.0",
  sha256: "1ff0625b34fdb2116ebf253455e7eea2b9221fc81450f180ec4dc0ddc26d7224",
} as const;

/** Exact Windows CI artifact qualified for bounded keys and continuous pointer work. */
export const KEY_HOLD_RUNTIME = {
  source: "3b3305044b7b327310615aa99d3307948a63061c", version: "0.34.0",
  sha256: "9786ace009b81fb2555f14f64b605ab20c3bfc309493398424be1183532df749",
} as const;
/** Exact Windows CI artifact for selected-monitor research; temporary live use still needs owner approval. */
export const SELECTED_DISPLAY_RUNTIME = {
  source: "38f50121c9cc15938a18330f4c3334a27f898e83", version: "0.34.0",
  sha256: "1dbd499cfd43b98f31dc3fb51c7a001dc72bd116db235c304c0486b32df8a24d",
} as const;
/** Exact Windows CI artifact with capture-bound straight drag; live application qualification is separate. */
export const CAPTURE_DRAG_RUNTIME = {
  source: "1f884e285d51559a7b8e58f71b15e864f6770be1", version: "0.34.0",
  sha256: "e71483361f7c7348e43a3ee7e65f374df108b66381087c45e7091d9b5bb4218c",
} as const;
/** Exact Windows CI candidate for documented read-only shell membership; live qualification is separate. */
export const SHELL_DESKTOP_RUNTIME = {
  source: "506239da08cfdafa63dac1857f5471752fb70f5e", version: "0.34.0",
  sha256: "0e25c8b83fd48b54be479eb128452a6f6b099b5ff6ce2d20bac024eda07ead16",
} as const;
/** Exact Windows artifact with pixel-first single-PNG overviews; earlier capture/input capabilities stay unchanged. */
export const SINGLE_PNG_RUNTIME = {
  source: "c2d84f0947b6ec0170cb8bd3114fe62e42e5bdd9", version: "0.34.0",
  sha256: "f63720485d48bfcc2637f1b65dc875241b10ad1fdd6e30847fdfde9f39a2b505",
} as const;
/** Exact Windows artifact for strict UIA actions; live app and focus checks remain separate. */
export const SEMANTIC_RUNTIME = {
  source: "ab86b25cba1cb9c6f5025f25fdd7a8cb3cd21a44", version: "0.34.0",
  sha256: "17cf450b3e202b9f4b4153133dfb8f4bc3d8121c5f2d0246a6c3ec78e3f49185",
} as const;
/** Exact Windows artifact for SIMD Bilinear window and display overviews; PNG and input stay unchanged. */
export const FAST_BILINEAR_RUNTIME = {
  source: "4825375a7d7827cd5dcf0f34924aa45611533853", version: "0.34.0",
  sha256: "237cf3f4d32f3dd92a9f99041452e2d755e0d837c92ef76eba2f03e6a36df58c",
} as const;
/** Exact Windows artifact for one best-effort process-name query; capture and input stay unchanged. */
export const DIRECT_PROCESS_RUNTIME = {
  source: "33e264ffe6310151450020945d2398072c446c49", version: "0.34.0",
  sha256: "a3219d246f3b951965c07a13b0ffd0509ab2f66861f0087fd337d7e3084de674",
} as const;
/** Exact separate Windows candidate for opt-in retained capture; no default-route adoption. */
export const PERSISTENT_WGC_RUNTIME = {
  source: "841dad7e11619bf7ecba3f98e1c20319cbeb7e52", version: "0.34.0",
  sha256: "cf45f42407b06da75c20d21e45da0c68093ccc43afeeaf460a5c6a286794d20d",
} as const;
const forkRuntimes = {
  "windows-held-paths": HELD_PATH_RUNTIME,
  "windows-key-holds": KEY_HOLD_RUNTIME,
  "windows-selected-displays": SELECTED_DISPLAY_RUNTIME,
  "windows-capture-drag": CAPTURE_DRAG_RUNTIME,
  "windows-shell-desktops": SHELL_DESKTOP_RUNTIME,
  "windows-single-png": SINGLE_PNG_RUNTIME,
  "windows-semantic-actions": SEMANTIC_RUNTIME,
  "windows-fast-bilinear": FAST_BILINEAR_RUNTIME,
  "windows-direct-process": DIRECT_PROCESS_RUNTIME,
  "windows-persistent-wgc": PERSISTENT_WGC_RUNTIME,
};
/** Owned platform-native MCP child; Windows-host control can run through WSL interop. */
export class McpDriver implements Driver {
  private client?: Client;
  private transport?: StdioClientTransport;
  private stderr = "";

  private readonly windowIdentity?: WindowIdentity;
  private nativeTools?: Set<string>;

  private get forkRuntime() { return this.config.runtime ? forkRuntimes[this.config.runtime] : undefined; }
  private get bundledWindows() { return this.config.bundled?.target === "win32-x64"; }
  private get envelopes() { return !!this.config.bundled || this.forkRuntime !== undefined; }

  /** The native execution platform is independent of the npm host, especially in WSL. */
  get platform(): NativePlatform {
    const target = this.config.bundled?.target;
    if (target) return target.startsWith("win32") ? "windows" : target.startsWith("darwin") ? "macos" : "linux";
    return this.config.runtime || /\.exe$/i.test(this.config.command) || process.platform === "win32"
      ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  }

  /** Linux/macOS window lifetime binding is explicitly deferred, not replaced with pid/window_id. */
  get windowLifetime(): boolean { return this.platform === "windows"; }

  /** Custom held paths remain Windows-only and require checked fork bytes or a pinned bundle. */
  get heldPaths(): boolean { return this.bundledWindows || this.forkRuntime !== undefined; }
  get heldKeys(): boolean { return this.bundledWindows || ["windows-key-holds", "windows-selected-displays", "windows-capture-drag", "windows-shell-desktops", "windows-single-png", "windows-semantic-actions", "windows-fast-bilinear", "windows-direct-process", "windows-persistent-wgc"].includes(this.config.runtime ?? ""); }
  get selectedDisplays(): boolean { return this.bundledWindows || ["windows-selected-displays", "windows-capture-drag", "windows-shell-desktops", "windows-single-png", "windows-semantic-actions", "windows-fast-bilinear", "windows-direct-process", "windows-persistent-wgc"].includes(this.config.runtime ?? ""); }
  get captureBoundDrag(): boolean { return this.bundledWindows || ["windows-capture-drag", "windows-shell-desktops", "windows-single-png", "windows-semantic-actions", "windows-fast-bilinear", "windows-direct-process", "windows-persistent-wgc"].includes(this.config.runtime ?? ""); }

  /** Experimental strict UIA can change focus; only the checked Windows fork supplies this route. */
  get semanticActions(): boolean { return this.bundledWindows || ["windows-semantic-actions", "windows-fast-bilinear", "windows-direct-process", "windows-persistent-wgc"].includes(this.config.runtime ?? ""); }
  /** Retained capture is opt-in and never inferred from an unqualified bundle or version. */
  get persistentWgc(): boolean { return this.config.runtime === "windows-persistent-wgc"; }
  /** Overview metadata follows the native implementation, not an agent-chosen filter. */
  get overviewKernel(): "bilinear" | "lanczos3" { return ["windows-fast-bilinear", "windows-direct-process", "windows-persistent-wgc"].includes(this.config.runtime ?? "") ? "bilinear" : "lanczos3"; }
  constructor(private readonly config: ComputerConfig, private readonly version: "0.33.2" = "0.33.2") {
    if (this.windowLifetime) this.windowIdentity = new WindowIdentity(config.interop ?? process.env.WSL_INTEROP);
  }

  /** Bind a native lifetime only where supported. Unsupported platforms never start a Windows peer. */
  identity(target: WindowTarget, create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    return this.windowIdentity?.identify(target, create, signal) ?? Promise.resolve(undefined);
  }

  private connecting?: Promise<Client>;

  private async connect(signal?: AbortSignal): Promise<Client> {
    signal?.throwIfAborted();
    if (this.client && !this.connecting) return this.client;
    const pending = this.connecting ??= this.start(signal);
    try {
      const client = await pending;
      signal?.throwIfAborted();
      return client;
    } finally { if (this.connecting === pending) this.connecting = undefined; }
  }

  private async start(signal?: AbortSignal): Promise<Client> {
    if (signal?.aborted) throw new Error("Cancelled before Driver startup.");
    if (this.config.bundled) {
      if (this.config.command !== this.config.bundled.command) throw new Error("native_runtime_command_mismatch");
      await verifyBundledRuntime(this.config.bundled, signal);
    } else if (this.forkRuntime) {
      const hash = createHash("sha256").update(await readFile(this.config.command)).digest("hex");
      if (hash !== this.forkRuntime.sha256) throw new Error("Native fork artifact hash mismatch; no Driver process was started.");
    }
    signal?.throwIfAborted();
    const interop = this.platform === "windows" ? this.config.interop ?? process.env.WSL_INTEROP : undefined;
    if (process.platform === "linux" && this.config.command.endsWith(".exe")) {
      if (!interop || !(await stat(interop).catch(() => undefined))?.isSocket())
        throw new Error("WSL interop endpoint is missing. Configure a live interop socket; do not install a Linux Driver for a Windows desktop.");
    }
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.envelopes ? ["mcp", "--direct", "--embedded"] : this.config.args ?? ["mcp", "--direct", "--embedded"],
      stderr: "pipe",
      env: {
        ...Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
        ...(interop ? { WSL_INTEROP: interop } : {}),
        WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", ...(this.envelopes ? ["CUA_DRIVER_MCP_ENVELOPES"] : []), "DO_NOT_TRACK"].filter(Boolean).join(":"),
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        CUA_DRIVER_RS_UPDATE_CHECK: "false",
        ...(this.envelopes ? { CUA_DRIVER_MCP_ENVELOPES: "1" } : {}),
        DO_NOT_TRACK: "1",
      },
    });
    this.stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.transport = transport;
    const client = new Client({ name: "pi-agent-computer-use-poc", version: "0.0.0" });
    this.client = client;
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
      const server = client.getServerVersion();
      const version = this.config.bundled?.driverVersion ?? this.forkRuntime?.version ?? this.version;
      if (server?.name !== "cua-driver" || server.version !== version)
        throw new Error(`This backend requires cua-driver ${version}. Requalify before changing the pin.`);
      if (this.envelopes && (client.getServerCapabilities()?.experimental?.["ai.cua.driver.envelopes"] as { version?: unknown } | undefined)?.version !== 1)
        throw new Error("The native fork runtime did not acknowledge its EOF-aware receiver.");
      if (this.config.bundled) {
        const { tools } = await client.listTools({}, { signal, timeout: 15_000 });
        this.nativeTools = new Set(tools.map(tool => tool.name));
        for (const name of ["list_apps", "list_windows", "get_window_state", "get_desktop_state"])
          if (!tools.some(tool => tool.name === name && tool.inputSchema.type === "object"))
            throw new Error(`native_runtime_schema_missing: ${name}`);
      }
      return client;
    } catch (error) {
      await this.close();
      throw new Error(`Driver startup failed: ${error instanceof Error ? error.message : error}\n${this.stderr}`);
    }
  }

  /** One cancellable native call. This method never retries input. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult> {
    if (name === "get_window_state" && args.capture_backend === "wgc" && !this.persistentWgc)
      return { content: [], structuredContent: { status: "refused", code: "persistent_wgc_unavailable", attempted: false, fallback: false }, isError: true };
    if (name === "semantic_action" && !this.semanticActions)
      return { content: [], structuredContent: { status: "refused", code: "semantic_action_unavailable", attempted: false, route: "accessibility", fallback: false }, isError: true };
    if (name === "drag" && args.capture_id !== undefined && !this.captureBoundDrag)
      return { content: [], structuredContent: { effect: "refused", code: "capture_bound_drag_unavailable" }, isError: true };
    if (["list_displays", "get_display_state"].includes(name) && !this.selectedDisplays)
      return { content: [], structuredContent: { effect: "refused", code: "selected_display_unavailable" }, isError: true };
    if (name === "drag" && args.via !== undefined && !this.heldPaths)
      return { content: [], structuredContent: { effect: "refused", code: "held_path_unavailable" }, isError: true };
    if (name === "hold_keys" && !this.heldKeys)
      return { content: [], structuredContent: { effect: "refused", code: "key_hold_unavailable" }, isError: true };
    const client = await this.connect(signal);
    if (this.nativeTools && !this.nativeTools.has(name))
      return { content: [], structuredContent: { status: "refused", code: "unsupported_native_capability", platform: this.platform, tool: name, attempted: false, fallback: false }, isError: true };
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 15_000 }));
    const content: Content[] = [];
    for (const block of result.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      if (block.type === "image") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
    return { content, structuredContent: result.structuredContent, isError: result.isError };
  }

  /** EOF owns shutdown; the SDK escalates only for this child if it does not exit. */
  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.nativeTools = undefined;
    try { await client?.close(); }
    finally {
      try { await transport?.close(); }
      finally { await this.windowIdentity?.close(); }
    }
  }
}
