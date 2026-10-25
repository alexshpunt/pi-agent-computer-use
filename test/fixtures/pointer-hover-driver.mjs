import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentCursor } from "./agent-cursor.mjs";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Deterministic MCP receipts and authority checks, not Windows application evidence.
const log = process.argv[2];
const bounds = { x: 10, y: 20, width: 1000, height: 700 };
const image = await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer();
const windows = [{ pid: 42, window_id: 93, app_name: "Notepad", title: "Unowned fixture", bounds }];
const identities = new Map([[93, "external:93"]]);
const captures = new Map();
let launched = 0, snapshot = 0, response = "success";
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const cursor = agentCursor(name, args); if (cursor) return cursor;
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state, pixels;
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
    const window_id = args.window_id;
    const id = `window-${window_id}-snapshot-${++snapshot}`;
    const elements = [{ element_token: `${id}:hover`, label: "Hover target", role: "Button", enabled: true,
      frame: { x: 170, y: 140, w: 160, h: 80 }, screenshot_frame: { x: 80, y: 60, w: 80, h: 40 }, actions: [] }];
    captures.set(window_id, { capture: id, token: elements[0].element_token });
    state = { window_bounds: bounds, screenshot_width: 500, screenshot_height: 350, snapshot_id: id, capture_id: id,
      elements: args.include_accessibility_tree === false ? [] : elements };
    pixels = args.include_screenshot === false ? undefined : image;
  } else if (name === "move_pointer") {
    const authority = captures.get(args.window_id);
    const admitted = args.pid === 42 && identities.has(args.window_id) && authority &&
      (args.element_token === authority.token || (args.capture_id === authority.capture && Number.isFinite(args.x) && Number.isFinite(args.y)));
    if (!admitted) throw Error("Pointer input reached the wrong native authority");
    captures.delete(args.window_id);
    if (args.delivery_mode === "background") state = { status: "refused", code: "background_unavailable",
      attempted: false, delivered: false, route: "native", foreground_changed: false, pointer_changed: false,
      escalation: { recommended: "foreground" } };
    else if (response === "partial") state = { status: "unknown", code: "pointer_moved", route: "native",
      attempted: true, delivered: true, delivery_mode: "foreground", dwell_ms: args.dwell_ms, dwell_elapsed_ms: 20,
      foreground_changed: true, pointer_changed: true, foreground_at_target: true, pointer_at_target: false };
    else state = { attempted: true, delivered: response !== "malformed", route: "native", effect: "unverifiable",
      delivery_mode: "foreground", dwell_ms: args.dwell_ms, dwell_elapsed_ms: args.dwell_ms,
      foreground_changed: null, pointer_changed: null, foreground_at_target: true, pointer_at_target: true };
  } else throw Error(`Unexpected native dispatch ${name}`);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(pixels ? [{ type: "image", data: pixels.toString("base64"), mimeType: "image/png" }] : [])] };
});
await server.connect(new StdioServerTransport());
