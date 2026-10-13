import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Synthetic native peer only; no real window, activation, pointer or keyboard effects.
const log = process.argv[2];
const png = await sharp({ create: { width: 100, height: 80, channels: 3, background: "white" } }).png().toBuffer();
const windows = [{ pid: 42, window_id: 93, app_name: "Notepad", title: "Unowned restore fixture", minimized: true }];
const identities = new Map([[93, "external:93"]]);
const states = new Map();
let opened = 0, serial = 0, outcome = "success";
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state, isError = false, image;
  if (name === "fixture_identity") state = { identity: identities.get(args.window_id) };
  else if (name === "fixture_control") {
    if (args.operation === "close_first") identities.delete(91);
    else if (args.operation === "reuse_second") identities.set(92, "replacement:92");
    else outcome = args.operation;
    state = {};
  } else if (name === "list_windows") state = { windows };
  else if (name === "list_apps") state = { apps: [{ name: "Notepad", launch_path: "fixture-notepad" }] };
  else if (name === "launch_app") {
    const window_id = 91 + opened++;
    windows.push({ pid: 42, window_id, app_name: "Notepad", title: `Owned restore fixture ${window_id}`, minimized: true });
    identities.set(window_id, `owned:${window_id}`);
    state = { pid: 42 };
  } else if (name === "get_window_status") {
    if (!identities.has(args.window_id)) throw Error("Status reached a missing native window");
    const state_id = `state-${args.window_id}-${++serial}`;
    states.set(args.window_id, state_id);
    state = { ...args, state_id, minimized: true, visible: true, foreground_at_target: false, keyboard_focus_at_target: null };
  } else if (name === "get_window_state") {
    if (!identities.has(args.window_id)) throw Error("UI reached a missing native window");
    state = { pid: args.pid, window_id: args.window_id, snapshot_id: `ui-${++serial}`, elements: [], elements_complete: true,
      window_bounds: { x: 0, y: 0, width: 100, height: 80 }, screenshot_width: 100, screenshot_height: 80 };
    if (args.include_screenshot !== false) image = png;
  } else if (name === "restore_window") {
    if (args.pid !== 42 || !identities.has(args.window_id) || states.get(args.window_id) !== args.state_id)
      throw Error("Restore reached foreign, closed or stale native state");
    states.delete(args.window_id);
    state = { ...args, route: "native", effect: "confirmed", restore_attempted: true, restore_requested: true,
      restored: true, activation_attempted: true, activation_succeeded: true, visible: true,
      foreground_at_target: true, keyboard_focus_at_target: null, foreground_changed: true };
    if (outcome === "refused") {
      Object.assign(state, { status: "refused", effect: "refused", code: "window_state_changed", restore_attempted: false,
        restore_requested: false, restored: false, activation_attempted: false, activation_succeeded: false,
        visible: null, foreground_at_target: null, foreground_changed: false });
      isError = true;
    } else if (outcome === "partial") {
      Object.assign(state, { status: "unknown", effect: "unknown", code: "activation_refused", activation_succeeded: false,
        foreground_at_target: false, foreground_changed: false });
      isError = true;
    } else if (outcome === "final_cancel") {
      Object.assign(state, { status: "unknown", effect: "unknown", code: "cancelled" });
      isError = true;
    } else if (outcome === "reused_after_restore") identities.set(args.window_id, "replacement-after-dispatch");
    else if (outcome === "wrong_state") state.state_id = "unrelated";
    else if (outcome === "wrong_window") state.window_id = 999;
    else if (outcome === "wrong_route") state.route = "assisted";
    else if (outcome === "missing_focus") delete state.keyboard_focus_at_target;
    else if (outcome === "not_foreground") state.foreground_at_target = false;
    outcome = "success";
  } else throw Error(`Unexpected native dispatch ${name}; restore must not use input or fallback`);
  return { isError, structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(image ? [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }] : [])] };
});
await server.connect(new StdioServerTransport());
