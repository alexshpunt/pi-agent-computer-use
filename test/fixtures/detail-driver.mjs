import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Real MCP boundary with synthetic pixels; this is not native Windows evidence.
const log = process.argv[2];
const raw = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "blue" } }).png().toBuffer();
const overview = await sharp(raw).resize(500, 400).png().toBuffer();
const jpeg = await sharp(raw).extract({ left: 200, top: 160, width: 200, height: 160 }).jpeg().toBuffer();
const windows = [];
const server = new Server({ name: "cua-driver", version: process.argv[3] ?? "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state; let bytes; let mimeType = "image/png";
  if (name === "fixture_identity") state = { identity: "owned-lifetime" };
  else if (name === "list_apps") state = { apps: [{ name: "Notepad", launch_path: "fixture-notepad" }] };
  else if (name === "launch_app") { windows.push({ pid: 42, window_id: 91, app_name: "Notepad", bounds: { x: 10, y: 20, width: 1000, height: 800 } }); state = { pid: 42 }; }
  else if (name === "list_windows") state = { windows };
  else if (name === "get_window_state") {
    state = { ...args, window_bounds: windows[0].bounds, screenshot_width: 500, screenshot_height: 400,
      elements: [{ element_token: "close", role: "button", label: "Close", actions: ["click"] }] }; bytes = overview;
  } else if (name === "zoom") { state = { width: 200, height: 160, x_offset: 200, y_offset: 160 }; bytes = jpeg; mimeType = "image/jpeg"; }
  else if (name === "get_desktop_state") {
    const native = args.max_image_dimension === 0;
    state = { display: "primary", platform: "windows", screen_width: 1000, screen_height: 800, scale_factor: 1,
      screenshot_width: native ? 1000 : 500, screenshot_height: native ? 800 : 400,
      screenshot_original_width: 1000, screenshot_original_height: 800, capture_id: "PRIVATE_NATIVE_DISPLAY" };
    bytes = native ? raw : overview;
  } else throw Error("Unexpected dispatch " + name);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(bytes ? [{ type: "image", data: bytes.toString("base64"), mimeType }] : [])] };
});
await server.connect(new StdioServerTransport());
