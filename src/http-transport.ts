import { Agent, request } from "node:http";
import type { Socket } from "node:net";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { connectRelay, type RelayCredentials } from "./relay-auth.ts";

const AGENT_OPTIONS = { keepAlive: true, maxSockets: 1, maxFreeSockets: 1 };

/** Node calls this asynchronous hook before it assigns a socket or writes HTTP headers. */
class RelayAgent extends Agent {
  constructor(private readonly url: URL, private readonly relay: RelayCredentials, private readonly signal: AbortSignal) {
    super(AGENT_OPTIONS);
  }

  createConnection(_options: unknown, callback: (error: Error | null, socket?: Socket) => void): void {
    void connectRelay(Number(this.url.port), this.relay, { channel: "driver", role: "client" }, this.url.hostname, this.signal)
      .then(socket => {
        if (this.signal.aborted) { socket.destroy(); callback(new Error("Transport closed.")); return; }
        callback(null, socket);
        socket.resume();
      }, error => callback(error));
  }
}

/**
 * MCP over the CUA driver's Streamable-HTTP endpoint on one keep-alive connection.
 * The driver scopes its session (snapshots, element tokens) to the TCP connection, so requests never fan out.
 */
export class SingleConnectionHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly agent: Agent;
  private closed = false;
  private readonly abort = new AbortController();

  constructor(private readonly url: URL, private readonly token: string, relay?: RelayCredentials) {
    this.agent = relay ? new RelayAgent(url, relay, this.abort.signal) : new Agent(AGENT_OPTIONS);
  }

  async start(): Promise<void> {}

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Transport closed."));
    const body = JSON.stringify(message);
    return new Promise((resolve, reject) => {
      const req = request(this.url, {
        method: "POST", agent: this.agent,
        headers: { "Authorization": `Bearer ${this.token}`, "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body) },
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status >= 400) { reject(new Error(`Driver HTTP ${status}: ${text.slice(0, 300)}`)); return; }
          try {
            for (const reply of parseReplies(text, String(response.headers["content-type"] ?? ""))) this.onmessage?.(reply);
            resolve();
          } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.agent.destroy();
    this.onclose?.();
  }
}

/** JSON-RPC replies from a JSON body (object or batch) or an SSE stream; notifications get an empty body. */
function parseReplies(text: string, contentType: string): JSONRPCMessage[] {
  if (!text.trim()) return [];
  if (contentType.includes("text/event-stream")) {
    return text.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      return data ? [JSON.parse(data) as JSONRPCMessage] : [];
    });
  }
  const parsed = JSON.parse(text) as JSONRPCMessage | JSONRPCMessage[];
  return Array.isArray(parsed) ? parsed : [parsed];
}
