import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic MCP receipts; this is not native UI evidence.
const log = process.argv[2]; let snapshot = 0;
const image = await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer();
const bounds = { x: 10, y: 20, width: 1000, height: 700 };
const windows = [91, 92].map(window_id => ({ pid: 42, window_id, title: `Fixture ${window_id}`, bounds }));
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state; let pixels;
  if (name === "fixture_identity") state = { identity: `owned:${args.window_id}` };
  else if (name === "list_windows") state = { windows };
  else if (name === "get_window_state") {
    const id = ++snapshot;
    const elements = Array.from({ length: 200 }, (_, i) => ({ element_index: i, element_token: `s${id}:${i}`,
      parent_index: i ? 0 : undefined, role: i ? "Button" : "Group", label: i ? "Save" : "Panel",
      enabled: i !== 2, actions: i ? ["invoke"] : [], screenshot_frame: i < 4 ? { x: 40 + i * 80, y: 80, w: 60, h: 25 } : undefined }));
    state = { window_bounds: bounds, screenshot_width: 500, screenshot_height: 350,
      snapshot_id: `s${id}`, elements: elements.slice(0, args.max_elements), elements_complete: false, truncated: true,
      truncation_reason: "max_elements", total_element_count: 200 };
    pixels = image;
  } else if (name === "click") state = { effect: "confirmed", path: "ax", verified: true };
  else throw Error(`Unexpected dispatch ${name}`);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(pixels ? [{ type: "image", data: pixels.toString("base64"), mimeType: "image/png" }] : [])] };
});
await server.connect(new StdioServerTransport());
