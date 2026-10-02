import { stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Content, Driver, DriverResult, WindowTarget } from "./session.ts";

/** Trusted operator configuration, not agent-supplied executable arguments. */
export interface ComputerConfig {
  command: string;
  args?: string[];
  interop?: string;
  target: WindowTarget;
}

/** Owned native Windows MCP process reached through WSL executable interop. */
export class McpDriver implements Driver {
  private client?: Client;
  private transport?: StdioClientTransport;
  private stderr = "";

  constructor(private readonly config: ComputerConfig) {}

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
      if (server?.name !== "cua-driver" || server.version !== "0.32.0")
        throw new Error("This PoC requires cua-driver 0.32.0. Requalify before changing the pin.");
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
    finally { await transport?.close(); }
  }
}
