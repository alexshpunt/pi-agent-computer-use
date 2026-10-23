import { appendFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Synthetic MCP only: no Windows, pointer, keyboard or activation backend.
const log = process.argv[2];
const png = await sharp({ create: { width: 100, height: 80, channels: 3, background: "white" } }).png().toBuffer();
const windows = [{ pid: 42, window_id: 93, app_name: "Notepad", title: "Unowned management fixture" }];
const identities = new Map([[93, "external:93"]]), admissions = new Map(), samples = new Map();
const clone = value => structuredClone(value);
const membership = () => ({ desktop_id: "12345678-1234-1234-1234-123456789abc", on_current_desktop: true,
  desktop_id_error: null, on_current_desktop_error: null, sampled_at_unix_ms: 1000 });
const initial = () => ({ bounds: { x: 30, y: 50, width: 100, height: 80 }, bounds_source: "dwm_visible_frame",
  coordinate_space: "windows_desktop_pixels", minimized: false, maximized: false, visible: true,
  foreground_at_target: false, keyboard_focus_at_target: null, foreground_window: 0, virtual_desktop: membership() });
samples.set(93, initial());
let opened = 0, serial = 0, outcome = "success";
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state, isError = false, image;
  const current = () => { if (!identities.has(args.window_id)) throw Error("Native query reached a closed source"); return samples.get(args.window_id); };
  if (name === "fixture_identity") state = { identity: identities.get(args.window_id) };
  else if (name === "fixture_control") {
    const sample = samples.get(args.window_id ?? 91);
    if (args.operation === "close_first") identities.delete(91);
    else if (args.operation === "reuse_second") identities.set(92, "replacement:92");
    else if (args.operation === "reset") samples.set(args.window_id ?? 91, initial());
    else if (args.operation === "minimized") sample.minimized = true;
    else if (args.operation === "maximized") sample.maximized = true;
    else if (args.operation === "outer_bounds") sample.bounds_source = "window_rect";
    else if (args.operation === "other_desktop") sample.virtual_desktop.on_current_desktop = false;
    else if (args.operation === "unknown_desktop") Object.assign(sample.virtual_desktop, {
      on_current_desktop: null, on_current_desktop_error: { code: "current_desktop_query_failed", hresult: -1 } });
    else outcome = args.operation;
    state = {};
  } else if (name === "list_windows") state = { windows };
  else if (name === "list_apps") state = { apps: [{ name: "Notepad", launch_path: "fixture-notepad" }] };
  else if (name === "launch_app") {
    const window_id = 91 + opened++;
    windows.push({ pid: 42, window_id, app_name: "Notepad", title: `Owned management fixture ${window_id}` });
    identities.set(window_id, `owned:${window_id}`); samples.set(window_id, initial()); state = { pid: 42 };
  } else if (name === "get_window_control_state" || name === "get_window_status") {
    const sample = clone(current()), state_id = `state-${args.window_id}-${++serial}`;
    admissions.set(args.window_id, state_id);
    state = name === "get_window_control_state" ? { pid: args.pid, window_id: args.window_id, state_id, state: sample }
      : { pid: args.pid, window_id: args.window_id, state_id, minimized: sample.minimized, visible: sample.visible,
        foreground_at_target: sample.foreground_at_target, keyboard_focus_at_target: sample.keyboard_focus_at_target };
  } else if (name === "get_window_state") {
    current();
    state = { pid: args.pid, window_id: args.window_id, snapshot_id: `ui-${++serial}`, elements: [], elements_complete: true,
      window_bounds: { x: 0, y: 0, width: 100, height: 80 }, screenshot_width: 100, screenshot_height: 80 };
    if (args.include_screenshot !== false) image = png;
  } else if (name === "manage_window" || name === "restore_window") {
    if (args.pid !== 42 || !identities.has(args.window_id) || admissions.get(args.window_id) !== args.state_id)
      throw Error("Management reached foreign, closed or consumed state");
    admissions.delete(args.window_id);
    const before = clone(current()), observed = clone(before);
    if (name === "restore_window") {
      Object.assign(observed, { minimized: false, foreground_at_target: true, keyboard_focus_at_target: null, foreground_window: args.window_id });
      samples.set(args.window_id, observed);
      state = { pid: args.pid, window_id: args.window_id, state_id: args.state_id, route: "native", effect: "confirmed",
        restore_attempted: true, restore_requested: true, restored: true, activation_attempted: true, activation_succeeded: true,
        visible: true, foreground_at_target: true, keyboard_focus_at_target: null, foreground_changed: true };
    } else {
      let requested_bounds = null;
      if (args.operation === "move") requested_bounds = { ...before.bounds, x: args.x, y: args.y };
      else if (args.operation === "resize") requested_bounds = { ...before.bounds, width: args.width, height: args.height };
      else if (args.operation === "minimize") observed.minimized = true;
      else if (args.operation === "maximize") observed.maximized = true;
      else if (args.operation === "focus") Object.assign(observed, { foreground_at_target: true, foreground_window: args.window_id, keyboard_focus_at_target: null });
      else throw Error(`Unexpected management operation ${args.operation}`);
      if (requested_bounds) observed.bounds = clone(requested_bounds);
      state = { pid: args.pid, window_id: args.window_id, state_id: args.state_id, operation: args.operation, requested_bounds,
        mutation_attempted: true, mutation_accepted: true, postcondition_confirmed: true, before, observed, route: "native", effect: "confirmed" };
      const desktop = before.virtual_desktop.on_current_desktop;
      const prohibited = (["move", "resize"].includes(args.operation) && (before.minimized || before.maximized)) ||
        (["focus", "maximize"].includes(args.operation) && (before.minimized || desktop !== true));
      if (outcome === "refused" || prohibited) {
        Object.assign(state, { status: "refused", effect: "refused", code: "window_state_changed", mutation_attempted: false,
          mutation_accepted: false, postcondition_confirmed: false, observed: null }); isError = true;
      } else if (outcome === "partial" || outcome === "final_cancel") {
        Object.assign(state, { status: "unknown", effect: "unknown", code: outcome === "final_cancel" ? "cancelled" : "window_management_timeout",
          postcondition_confirmed: outcome === "final_cancel" }); isError = true;
      } else if (outcome === "wrong_state") state.state_id = "foreign-state";
      else if (outcome === "wrong_window") state.window_id = 999;
      else if (outcome === "wrong_operation") state.operation = "resize";
      else if (outcome === "wrong_route") state.route = "assisted";
      else if (outcome === "missing_focus") delete observed.keyboard_focus_at_target;
      else if (outcome === "missing_prefix") delete state.mutation_accepted;
      else if (outcome === "missing_receipt") state = {};
      else if (outcome === "wrong_request") state.requested_bounds.x += 1;
      else if (outcome === "wrong_before") before.bounds.width += 1;
      else if (outcome === "constrained") observed.bounds.x += 1;
      else if (outcome === "changed_source") observed.bounds_source = "window_rect";
      else if (outcome === "contradictory_foreground") observed.foreground_at_target = true;
      else if (outcome === "reused_after_dispatch") identities.set(args.window_id, "replacement-after-dispatch");
      if (outcome !== "refused" && !prohibited) samples.set(args.window_id, clone(observed));
    }
    outcome = "success";
  } else throw Error(`Unexpected native dispatch ${name}; no input/capture fallback is allowed`);
  return { isError, structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(image ? [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }] : [])] };
});
await server.connect(new StdioServerTransport());
