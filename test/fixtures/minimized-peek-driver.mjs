import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentCursor } from "./agent-cursor.mjs";

// A native-shaped driver that records the arguments of every get_window_state call. With "peek" it lists the
// minimized_capture argument like the fork driver of LPT-1939; with "legacy" it does not, as every earlier driver.
const [log, mode] = process.argv.slice(2);
const properties = { pid: { type: "integer" }, window_id: { type: "integer" }, ...(mode === "peek" ? { minimized_capture: { type: "string", enum: ["refuse", "peek"] } } : {}) };
const tool = (name, props = {}) => ({ name, description: name, inputSchema: { type: "object", properties: props } });
const server = new Server({ name: "cua-driver", version: "0.62.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool("list_apps"), tool("list_windows"), tool("get_window_state", properties), tool("get_desktop_state")] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const cursor = agentCursor(name, args); if (cursor) return cursor;
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  const state = { pid: 42, window_id: 91,
    ...(mode === "peek" && args.minimized_capture === "peek" ? { minimized_capture: { mode: "peek", settle_ms: 150, held_ms: 480, window_bounds: { x: 1, y: 2, width: 3, height: 4 }, taken_over: false } } : {}) };
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) }] };
});
await server.connect(new StdioServerTransport());
