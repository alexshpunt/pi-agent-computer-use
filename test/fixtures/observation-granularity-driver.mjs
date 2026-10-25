import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentCursor } from "./agent-cursor.mjs";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// This peer deliberately retains omitted native parts. The adapter must not inherit their authority.
const log = process.argv[2]; let serial = 0;
const png = await sharp({ create: { width: 500, height: 320, channels: 3, background: "white" } }).png().toBuffer();
const bounds = { x: 80, y: 90, width: 1000, height: 640 };
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const cursor = agentCursor(name, args); if (cursor) return cursor;
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state; let image;
  if (name === "fixture_identity") state = { identity: `owned:${args.window_id}` };
  else if (name === "list_windows") state = { windows: [91, 92].map(window_id => ({ pid: 42, window_id, bounds })) };
  else if (name === "get_window_state") {
    const id = ++serial;
    state = { window_bounds: bounds, screenshot_width: 500, screenshot_height: 320, capture_id: `capture-${id}`,
      snapshot_id: `s${id}`, tree_markdown: "retained native tree", elements_complete: true,
      elements: [{ element_index: 0, element_token: `s${id}:0`, role: "Button", label: "Save", enabled: true,
        actions: ["invoke"], frame: { x: 180, y: 190, w: 100, h: 40 },
        screenshot_frame: { x: 50, y: 50, w: 50, h: 20 } }] };
    if (args.include_screenshot !== false) image = png;
  } else if (name === "click") state = { effect: "confirmed", path: args.element_token ? "ax" : "pixel", verified: true };
  else throw Error(`Unexpected native call ${name}`);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(image ? [{ type: "image", mimeType: "image/png", data: image.toString("base64") }] : [])] };
});
await server.connect(new StdioServerTransport());
