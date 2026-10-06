import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic MCP input receipts, not evidence of native application behavior.
const log = process.argv[2];
const image = await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer();
const windows = [];
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state; let pixels;
  if (name === "fixture_identity") state = { identity: "owned-lifetime" };
  else if (name === "list_apps") state = { apps: [{ name: "Notepad", launch_path: "fixture-notepad" }] };
  else if (name === "launch_app") { windows.push({ pid: 42, window_id: 91, app_name: "Notepad", bounds: { x: 10, y: 20, width: 1000, height: 700 } }); state = { pid: 42 }; }
  else if (name === "list_windows") state = { windows };
  else if (name === "get_window_state") {
    state = { window_bounds: windows[0].bounds, screenshot_width: 500, screenshot_height: 350, capture_id: "once",
      elements: [{ element_token: "field", role: "textbox", label: "Field", actions: ["type_text"] }] }; pixels = image;
  } else if (name === "fixture_held_path") { state = {
    effect: "partial", delivery: { delivered_count: 2 }, summary: "2/4 points; pressed=true released=true",
  };
  } else if (["press_key", "hotkey", "type_text", "drag"].includes(name)) state = {
    effect: args.key === "escape" ? "partial" : args.key === "delete" ? "refused" : "unverifiable",
  };
  else throw Error("Unexpected dispatch " + name);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(pixels ? [{ type: "image", data: pixels.toString("base64"), mimeType: "image/png" }] : [])] };
});
await server.connect(new StdioServerTransport());
