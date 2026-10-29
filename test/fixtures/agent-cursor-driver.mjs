import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic MCP peer for the startup cursor setting. Mode: applies, refuses or ignores the glide, or has no
// overlay: then the glide stays unset and the cursor is reported disabled.
const [log, mode] = process.argv.slice(2);
let glide = 0;
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (mode === "visuals-retry-discovery" && !existsSync(log)) {
    appendFileSync(log, JSON.stringify({ name: "discovery_wait", arguments: {} }) + "\n");
    await new Promise(() => {});
  }
  return { tools: mode.startsWith("visuals") ? ["present_agent_activity", "set_agent_visuals"].map(name => ({ name, inputSchema: { type: "object" } })) : [] };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  if (name === "set_agent_visuals" && mode === "visuals-retry-configuration" && !existsSync(log + ".configured")) {
    writeFileSync(log + ".configured", "ready");
    await new Promise(() => {});
  }
  if (name === "set_agent_visuals" && mode === "visuals-refused") return { content: [], isError: true };
  if (name === "set_agent_cursor_motion") {
    if (mode === "refuses") return { content: [{ type: "text", text: "refused" }], isError: true };
    if (mode === "applies") glide = args.glide_duration_ms;
  }
  if (name === "get_agent_cursor_state")
    return { content: [], structuredContent: { enabled: mode !== "no-overlay", motion: { glide_duration_ms: glide } } };
  return { content: [], structuredContent: { windows: [] } };
});
await server.connect(new StdioServerTransport());
