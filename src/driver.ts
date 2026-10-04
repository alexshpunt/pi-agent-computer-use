import { stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Content, Driver, DriverResult, WindowTarget } from "./session.ts";

import type { ComputerConfig } from "./config.ts";
import { WindowIdentity } from "./window-identity.ts";

/** Owned native Windows MCP process reached through WSL executable interop. */
export class McpDriver implements Driver {
  private client?: Client;
  private transport?: StdioClientTransport;
  private stderr = "";

  private readonly windowIdentity: WindowIdentity;

  /** Each backend opts into one qualified pin; desktop remains on 0.32.0. */
  constructor(private readonly config: ComputerConfig, private readonly version: "0.32.0" | "0.33.1" = "0.32.0") {
    this.windowIdentity = new WindowIdentity(config.interop ?? process.env.WSL_INTEROP);
  }

  /** Bind or validate a native window lifetime. Normal permissions still apply. */
  identity(target: WindowTarget, create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    return this.windowIdentity.identify(target, create, signal);
  }

  private async connect(signal?: AbortSignal): Promise<Client> {
    if (signal?.aborted) throw new Error("Cancelled before Driver startup.");
    if (this.client) return this.client;
    const interop = this.config.interop ?? process.env.WSL_INTEROP;
    if (process.platform === "linux" && this.config.command.endsWith(".exe")) {
      if (!interop || !(await stat(interop).catch(() => undefined))?.isSocket())
        throw new Error("WSL interop endpoint is missing. Configure a live interop socket; do not install a Linux Driver for a Windows desktop.");
    }
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? ["mcp", "--direct", "--embedded"],
      stderr: "pipe",
      env: {
        ...(interop ? { WSL_INTEROP: interop } : {}),
        WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"].filter(Boolean).join(":"),
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        CUA_DRIVER_RS_UPDATE_CHECK: "false",
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
      if (server?.name !== "cua-driver" || server.version !== this.version)
        throw new Error(`This backend requires cua-driver ${this.version}. Requalify before changing the pin.`);
      return client;
    } catch (error) {
      await this.close();
      throw new Error(`Driver startup failed: ${error instanceof Error ? error.message : error}\n${this.stderr}`);
    }
  }

  /** One cancellable native call. This method never retries input. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult> {
    const client = await this.connect(signal);
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
    try { await client?.close(); }
    finally {
      try { await transport?.close(); }
      finally { await this.windowIdentity.close(); }
    }
  }
}
