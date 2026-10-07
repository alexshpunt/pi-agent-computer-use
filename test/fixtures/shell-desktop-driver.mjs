import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic wire-contract peer, not evidence of Windows COM or live desktop behavior.
const log = process.argv[2];
const first = "00112233-4455-6677-8899-aabbccddeeff";
const second = "11223344-5566-7788-99aa-bbccddeeff00";
const sample = (desktop_id, current) => ({ desktop_id, on_current_desktop: current,
  desktop_id_error: null, on_current_desktop_error: null, sampled_at_unix_ms: 42 });
const pixels = (await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer()).toString("base64");
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state; let image = false;
  if (name === "fixture_identity") state = { identity: "lifetime-" + args.window_id };
  else if (name === "list_windows") state = { windows: [
    { pid: 42, window_id: 101, title: "Fixture one", virtual_desktop: sample(first, true) },
    { pid: 42, window_id: 102, title: "Fixture two", virtual_desktop: sample(second, false) },
  ] };
  else if (name === "get_window_state") {
    state = { elements: [], screenshot_width: 20, screenshot_height: 20, window_bounds: { x: 0, y: 0, width: 20, height: 20 },
      virtual_desktop: sample(second, false) }; image = true;
  } else throw Error("Unexpected call " + name);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(image ? [{ type: "image", mimeType: "image/png", data: pixels }] : [])] };
});
await server.connect(new StdioServerTransport());
