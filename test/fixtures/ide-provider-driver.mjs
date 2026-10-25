import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentCursor } from "./agent-cursor.mjs";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Synthetic native receipts only. This peer never opens or inputs to the real desktop.
const log = process.argv[2];
const bounds = { x: 10, y: 20, width: 1000, height: 700 };
const png = await sharp({ create: { width: 500, height: 350, channels: 3, background: "white" } }).png().toBuffer();
const jpeg = await sharp({ create: { width: 100, height: 70, channels: 3, background: "white" } }).jpeg().toBuffer();
const windows = [{ pid: 42, window_id: 93, app_name: "Notepad", title: "Unowned fixture", bounds }];
const identities = new Map([[93, "external:93"]]);
const captures = new Map();
let opened = 0, serial = 0, response = "success", field = "Initial fixture value";
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const cursor = agentCursor(name, args); if (cursor) return cursor;
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state, image, mimeType = "image/png";
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
    const window_id = 91 + opened++;
    windows.push({ pid: 42, window_id, app_name: "Notepad", title: `Owned fixture ${window_id}`, bounds });
    identities.set(window_id, `owned:${window_id}`);
    state = { pid: 42 };
  } else if (name === "get_window_state") {
    if (!identities.has(args.window_id)) throw Error("Capture reached a missing native window");
    const snapshot_id = `window-${args.window_id}-snapshot-${++serial}`;
    const elements = [{ element_token: `${snapshot_id}:field`, element_index: 0, parent_index: null,
      label: "Fixture text field", value: field, role: "Edit", enabled: true, depth: 0,
      frame: { x: 170, y: 140, w: 160, h: 80 }, screenshot_frame: { x: 80, y: 60, w: 80, h: 40 }, actions: [] },
      { element_token: `${snapshot_id}:button`, element_index: 1, parent_index: null,
        label: "Fixture button", role: "Button", enabled: true, depth: 0,
        frame: { x: 410, y: 340, w: 160, h: 80 }, screenshot_frame: { x: 200, y: 160, w: 80, h: 40 }, actions: [] }];
    if (response === "large_tree") for (let index = 2; index < 120; index++) elements.push({
      element_token: `${snapshot_id}:large-${index}`, element_index: index, parent_index: null,
      label: index === 119 ? "Last collected control" : `Control ${index} ${"x".repeat(900)}`, role: "Text", enabled: true, depth: 0, actions: [],
    });
    captures.set(args.window_id, { id: snapshot_id, tokens: elements.map(e => e.element_token) });
    state = { window_bounds: bounds, screenshot_width: 500, screenshot_height: 350, snapshot_id,
      capture_id: snapshot_id, elements_complete: true, total_element_count: elements.length,
      elements: args.include_accessibility_tree === false ? [] : elements };
    image = args.include_screenshot === false ? undefined : png;
  } else if (name === "zoom") {
    if (!identities.has(args.window_id)) throw Error("Detail reached a missing native window");
    captures.delete(args.window_id);
    state = { width: 100, height: 70, window_bounds: bounds };
    image = jpeg; mimeType = "image/jpeg";
  } else if (name === "get_desktop_state") {
    state = { display: "primary", screenshot_width: 500, screenshot_height: 350, capture_id: "display-read-only" };
    image = png;
  } else if (["type_text", "click", "press_key", "hotkey"].includes(name)) {
    const target = args.target;
    const current = captures.get(target?.window_id);
    if (target?.kind !== "window" || target.pid !== 42 || !identities.has(target.window_id) || !current ||
      (args.element_token !== undefined && !current.tokens.includes(args.element_token)) ||
      (args.capture_id !== undefined && args.capture_id !== current.id))
      throw Error("Input reached stale, foreign or missing native authority");
    captures.delete(target.window_id);
    if (response === "partial") {
      state = { status: "unknown", attempted: true, delivered: true, effect: "partial", code: "fixture_interrupted" };
      response = "success";
    } else {
      if (name === "type_text") field = args.text;
      state = { status: "delivered", attempted: true, delivered: true, delivery_mode: args.delivery_mode };
    }
  } else throw Error(`Unexpected native dispatch ${name}`);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(image ? [{ type: "image", data: image.toString("base64"), mimeType }] : [])] };
});
await server.connect(new StdioServerTransport());
