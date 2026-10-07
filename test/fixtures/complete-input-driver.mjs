import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic MCP input receipts, not evidence of native application behavior.
const log = process.argv[2];
const captureDrag = process.argv[3] === "capture-drag";
let capture; let captureCount = 0;
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
    if (captureDrag) {
      capture = { id: `capture-${++captureCount}`, width: windows[0].bounds.width };
      state.capture_id = capture.id;
    }
  } else if (name === "fixture_key_hold") { state = {
    effect: args.keys.includes("escape") ? "partial" : "unverifiable",
    summary: args.keys.includes("escape") ? "Windows key hold: pressed=[escape], keys_released=false, pointer_prefix=[(1, true, false)]." : "Windows key hold: pressed=[shift,w], keys_released=true, duration_ms=500, held_ms=501.",
  };
  } else if (name === "fixture_held_path") { state = {
    effect: "partial", delivery: { delivered_count: 2 }, summary: "2/4 points; pressed=true released=true",
  };
  } else if (captureDrag && name === "drag") {
    state = !capture || args.capture_id !== capture.id
      ? { effect: "refused", code: "capture_not_found" }
      : capture.width !== windows[0].bounds.width
        ? { effect: "refused", code: "capture_frame_mismatch" }
        : { effect: "unverifiable", route: "synthetic_events", delivery: { mode: args.delivery_mode } };
    if (state.effect !== "refused") capture = undefined;
  } else if (["press_key", "hotkey", "type_text", "drag"].includes(name)) state = {
    effect: args.key === "escape" ? "partial" : args.key === "delete" ? "refused" : "unverifiable",
    ...(args.key === "delete" ? { code: "background_unavailable", event_kind: "keystroke", escalation: { recommended: "foreground" } }
      : { route: "synthetic_events", delivery: { mode: args.delivery_mode } }),
  };
  else throw Error("Unexpected dispatch " + name);
  if (captureDrag && name === "press_key" && args.key === "r") windows[0].bounds.width = 1200;
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(pixels ? [{ type: "image", data: pixels.toString("base64"), mimeType: "image/png" }] : [])] };
});
await server.connect(new StdioServerTransport());
