import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentCursor } from "./agent-cursor.mjs";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Synthetic native contract peer, never Windows evidence.
const log = process.argv[2];
const displays = [0, 1].map(i => ({ display_id: "native-" + i, monitor_handle: "handle-" + i, monitor_device_paths: ["path-" + i],
  bounds: { x: i ? -1000 : 0, y: 0, width: 1000, height: 800 }, work_area: { x: i ? -1000 : 0, y: 0, width: 1000, height: 760 },
  primary: i === 0, scale_factor: i ? 1.5 : 1, dpi: null }));
const pixels = await Promise.all(["blue", "green"].map(async background => {
  const raw = await sharp({ create: { width: 1000, height: 800, channels: 3, background } }).png().toBuffer();
  return { raw, small: await sharp(raw).resize(500, 400).png().toBuffer() };
}));
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const cursor = agentCursor(name, args); if (cursor) return cursor;
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state; let bytes;
  if (name === "list_displays") state = { platform: "windows", topology_id: "topology-fixture", displays };
  else if (name === "get_display_state") {
    const index = displays.findIndex(d => d.display_id === args.display_id);
    if (index < 0 || args.topology_id !== "topology-fixture") return { isError: true, structuredContent: { status: "refused", code: "display_unavailable" }, content: [] };
    const full = args.max_image_dimension === 0;
    bytes = full ? pixels[index].raw : pixels[index].small;
    state = { platform: "windows", topology_id: "topology-fixture", display: displays[index], screenshot_width: full ? 1000 : 500,
      screenshot_height: full ? 800 : 400, screenshot_original_width: 1000, screenshot_original_height: 800 };
  } else throw Error("Unexpected native fallback/input " + name);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(bytes ? [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] : [])] };
});
await server.connect(new StdioServerTransport());
