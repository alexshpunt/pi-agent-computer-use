import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A real native-shaped partial success: UI was read, but the minimized window has no screenshot.
const log = process.argv[2]; let reads = 0;
const png = await sharp({ create: { width: 100, height: 80, channels: 3, background: "blue" } }).png().toBuffer();
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state; let image;
  if (name === "fixture_identity") state = { identity: "owned window lifetime" };
  else if (name === "list_windows") state = { windows: [{ pid: 42, window_id: 91 }] };
  else if (name === "get_window_state") {
    const id = ++reads;
    state = { pid: 42, window_id: 91, window_bounds: { x: 10, y: 20, width: 100, height: 80 },
      elements: [{ element_token: `s${id}:0`, label: "Text editor", role: "Document", actions: ["set_value"] }],
      snapshot_id: `s${id}` };
    if (id === 1) {
      Object.assign(state, { capture_id: "first capture", screenshot_width: 100, screenshot_height: 80 }); image = png;
    } else state.screenshot_error = "cannot capture minimized window: it has no rendered content";
  } else throw Error(`Unexpected input or activation ${name}`);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(image ? [{ type: "image", mimeType: "image/png", data: image.toString("base64") }] : [])] };
});
await server.connect(new StdioServerTransport());
