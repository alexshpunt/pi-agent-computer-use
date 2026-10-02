import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic MCP peer for wrapper contracts, never native Windows qualification.
const log = process.argv[2];
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE6cAAAAASUVORK5CYII=";
let snapshot = 0;
let nextWindow = 100;
const windows = [];
const server = new Server({ name: "cua-driver", version: "0.32.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  appendFileSync(log, JSON.stringify(request.params) + "\n");
  const { name, arguments: args } = request.params;
  let state;
  if (name === "list_apps") state = { apps: [{ name: "Notepad", kind: "uwp",
    launch_path: "shell:appsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" }] };
  else if (name === "launch_app") {
    const window = { pid: 42, window_id: ++nextWindow, app_name: "Notepad", title: "Owned blank Notepad" };
    windows.push(window);
    state = { pid: 42, windows: [window] };
  } else if (name === "fixture_identity") state = { identity: `lifetime:${args.pid}:${args.window_id}` };
  else if (name === "get_window_state") state = { snapshot_id: "s" + ++snapshot, ...args,
    elements: [{ element_token: "s" + snapshot + ":0", role: "edit", value: "", enabled: true }] };
  else state = { windows, effect: "unverifiable" };
  return { content: [
    { type: "text", text: JSON.stringify(state) },
    ...(name === "get_window_state" ? [{ type: "image", data: png, mimeType: "image/png" }] : []),
  ], ...(name !== "launch_app" ? { structuredContent: state } : {}) };
});
process.stdin.on("end", () => appendFileSync(log, JSON.stringify({ event: "stdin-eof" }) + "\n"));
await server.connect(new StdioServerTransport());
