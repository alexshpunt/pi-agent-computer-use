import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentCursor } from "./agent-cursor.mjs";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic authority/receipt witnesses, not Windows application or native scroll evidence.
const log = process.argv[2];
const bounds = { x: 10, y: 20, width: 1000, height: 700 };
const image = await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer();
const detail = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).jpeg().toBuffer();
const windows = [{ pid: 42, window_id: 93, app_name: "Notepad", title: "Unowned fixture", bounds }];
const identities = new Map([[93, "external:93"]]), captures = new Map();
let launched = 0, snapshot = 0, response = "success";
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const cursor = agentCursor(name, args); if (cursor) return cursor;
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state, pixels, mimeType = "image/png";
  if (name === "fixture_identity") state = { identity: identities.get(args.window_id) };
  else if (name === "fixture_control") {
    if (args.operation === "close_first") {
      identities.delete(91);
      windows.splice(windows.findIndex(w => w.window_id === 91), 1);
    } else if (args.operation === "recycle_second") identities.set(92, "reused:92");
    else response = args.operation;
    state = {};
  } else if (name === "list_apps") state = { apps: [{ name: "Notepad", launch_path: "fixture-notepad" }] };
  else if (name === "list_windows") state = { windows };
  else if (name === "launch_app") {
    const window_id = 91 + launched++;
    windows.push({ pid: 42, window_id, app_name: "Notepad", title: `Owned fixture ${window_id}`, bounds });
    identities.set(window_id, `owned:${window_id}`);
    state = { pid: 42 };
  } else if (name === "get_window_state") {
    const window_id = args.window_id, id = `window-${window_id}-snapshot-${++snapshot}`;
    captures.set(window_id, id);
    state = { window_bounds: bounds, screenshot_width: 500, screenshot_height: 350, snapshot_id: id, capture_id: id,
      elements: args.include_accessibility_tree === false ? [] : [{
        element_token: `${id}:panel`, label: "Synthetic panel", role: "Pane", enabled: true,
        frame: { x: 170, y: 140, w: 160, h: 80 }, screenshot_frame: { x: 80, y: 60, w: 80, h: 40 }, actions: [],
      }] };
    pixels = args.include_screenshot === false ? undefined : image;
  } else if (name === "zoom") {
    state = { width: 100, height: 100 };
    pixels = detail;
    mimeType = "image/jpeg";
  } else if (name === "scroll_at") {
    const delta_x = args.delta_x ?? 0, delta_y = args.delta_y ?? 0;
    if (args.pid !== 42 || !identities.has(args.window_id) || args.capture_id !== captures.get(args.window_id) ||
      !Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0 || args.x >= 500 || args.y >= 350 ||
      args.unit !== "wheel_detents" || !Number.isInteger(delta_x) || !Number.isInteger(delta_y) ||
      Math.abs(delta_x) > 50 || Math.abs(delta_y) > 50 || (!delta_x && !delta_y) ||
      Object.keys(args).some(key => !["pid", "window_id", "capture_id", "x", "y", "delta_x", "delta_y", "unit", "delivery_mode"].includes(key)))
      throw Error("Scroll input reached the wrong native authority or unit");
    captures.delete(args.window_id);
    const axes = [...(delta_y ? ["y"] : []), ...(delta_x ? ["x"] : [])];
    state = { attempted: true, delivered: true, pointer_attempted: true, pointer_delivered: true,
      delta_x, delta_y, unit: args.unit, attempted_axes: axes, delivered_axes: axes,
      route: "native", effect: "unverifiable", delivery_mode: "foreground",
      foreground_changed: null, pointer_changed: null, foreground_at_target: true, pointer_at_target: true };
    if (args.delivery_mode === "background" && response !== "background_success")
      state = { status: "refused", code: "background_unavailable", attempted: false, delivered: false,
        pointer_attempted: false, pointer_delivered: false, attempted_axes: [], delivered_axes: [],
        foreground_changed: false, pointer_changed: false, escalation: { recommended: "foreground" } };
    else if (response === "partial")
      state = { ...state, status: "unknown", code: "cancelled", delivered: false, delivered_axes: ["y"] };
    else if (response === "last_check")
      state = { ...state, status: "unknown", code: "foreground_lost", delivered: false, foreground_at_target: false };
    else if (response === "wrong_unit") state.unit = "pixels";
    else if (response === "wrong_delta") state.delta_y += 1;
    else if (response === "wrong_axes") state.delivered_axes = ["x", "y"];
  } else throw Error(`Unexpected native dispatch ${name}`);
  return { structuredContent: state, isError: ["refused", "unknown"].includes(state.status),
    content: [{ type: "text", text: JSON.stringify(state) },
      ...(pixels ? [{ type: "image", data: pixels.toString("base64"), mimeType }] : [])] };
});
await server.connect(new StdioServerTransport());
