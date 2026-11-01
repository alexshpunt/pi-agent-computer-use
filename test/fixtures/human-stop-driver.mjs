import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentCursor } from "./agent-cursor.mjs";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic MCP peer for the human stop: `press_key` with key "escape-x3" plays three physical Escape presses
// during the call, as the native hook would see them. Never native Windows qualification.
const log = process.argv[2];
const mode = process.argv[3] ?? "notify";
const record = entry => appendFileSync(log, JSON.stringify(entry) + "\n");
record({ event: "start", pid: process.pid, env: Object.fromEntries(["CUA_ESCAPE_STOP", "CUA_SHARED_INPUT_LOCK", "CUA_SESSION_LABEL", "CUA_HUMAN_IDLE_MS"].map(name => [name, process.env[name] ?? null])) });
let stopped = false;
const refusal = () => ({ content: [{ type: "text", text: "human_stop: the human pressed Escape three times and stopped agent input." }], isError: true,
  structuredContent: { status: "refused", effect: "refused", code: "human_stop" } });
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const cursor = agentCursor(request.params.name, request.params.arguments); if (cursor) return cursor;
  const { name, arguments: args } = request.params;
  record({ name, arguments: args });
  if (stopped) return refusal();
  if (name === "press_key" && args?.key === "escape-x3") {
    stopped = true;
    // The notification is sent as soon as the hook sees the third press; the running call then stops.
    if (mode === "notify") await server.notification({ method: "notifications/cua/human_stop", params: { code: "human_stop" } });
    return refusal();
  }
  return { content: [{ type: "text", text: "{}" }], structuredContent: { effect: "unverifiable", windows: [] } };
});
process.stdin.on("end", () => record({ event: "stdin-eof", pid: process.pid }));
await server.connect(new StdioServerTransport());
