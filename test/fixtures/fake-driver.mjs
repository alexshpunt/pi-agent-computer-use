import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic MCP peer for wrapper contracts, not Windows qualification.
const log = process.argv[2];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE6cAAAAASUVORK5CYII=";
let snapshot = 0;
const server = new Server({ name: "cua-driver", version: "0.32.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["list_windows", "get_window_state", "type_text"].map((name) => ({
    name, inputSchema: { type: "object", additionalProperties: true },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  appendFileSync(log, JSON.stringify(request.params) + "\n");
  const { name } = request.params;
  const state = name === "get_window_state"
    ? { snapshot_id: "s" + ++snapshot, pid: 42, window_id: 100,
      elements: [{ element_token: "s" + snapshot + ":0", role: "edit", value: "", enabled: true }] }
    : { windows: [{ pid: 42, window_id: 100, title: "Owned blank Notepad" }], effect: "unverifiable" };
  return {
    content: [
      { type: "text", text: JSON.stringify(state) },
      ...(name === "get_window_state" ? [{ type: "image", data: png, mimeType: "image/png" }] : []),
    ],
    structuredContent: state,
  };
});
process.stdin.on("end", () => appendFileSync(log, JSON.stringify({ event: "stdin-eof" }) + "\n"));
await server.connect(new StdioServerTransport());
