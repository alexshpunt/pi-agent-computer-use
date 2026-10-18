import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A synthetic MCP peer only. No browser, screenshot, OS input or network page exists.
const log = process.argv[2];
let serial = 0, outcome = "success";
const snapshots = new Map();
const locator = { type: "object", additionalProperties: false, minProperties: 1,
  properties: Object.fromEntries(["role", "name", "label", "text", "test_id", "css"].map(key => [key, { type: "string", minLength: 1, maxLength: 256 }])) };
const actions = ["click", "double_click", "right_click", "hover", "fill", "type", "press", "check", "uncheck", "select_option", "focus", "scroll_into_view"];
const request = { type: "object", additionalProperties: false, required: ["action", "locator"], properties: {
  action: { type: "string", enum: actions }, locator, timeout_ms: { type: "integer", minimum: 1, maximum: 10000 },
  text: { type: "string", maxLength: 2000 }, key: { type: "string", minLength: 1, maxLength: 64 },
  values: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", maxLength: 256 } },
  dwell_ms: { type: "integer", minimum: 1, maximum: 10000 },
} };
const id = { type: "string", minLength: 1, maxLength: 256 };
const tools = ["start_session", "end_session", "list_windows", "fixture_identity", "fixture_control"].map(name => ({ name, inputSchema: { type: "object", properties: {} } }));
tools.push({ name: "get_browser_state", inputSchema: { type: "object", properties: {
  snapshot_format: { type: "string", enum: ["dom_inspect_v1"] }, locator,
  scope_ref: { type: "string" }, include_hidden: { type: "boolean" }, geometry_ref: id,
  max_nodes: { type: "integer", minimum: 1, maximum: 200 }, max_depth: { type: "integer", minimum: 1, maximum: 32 },
  screenshot_mode: { type: "string", enum: ["viewport", "surface_unclipped", "native_view"] },
} } });
tools.push({ name: "browser_dom_action", inputSchema: { type: "object", additionalProperties: false,
  required: ["session", "target_id", "tab_id", "source_ref", "input_route", "request"], properties: {
    session: id, target_id: id, tab_id: id, source_ref: id, input_route: { type: "string", enum: ["dom_event", "trusted"] }, request,
  } } });
const actionTool = tools.find(tool => tool.name === "browser_dom_action");
if (process.argv[3] === "missing_action") tools.splice(tools.indexOf(actionTool), 1);
if (process.argv[3] === "wrong_route") actionTool.inputSchema.properties.input_route.enum = ["dom_event"];
if (process.argv[3] === "open_request") request.additionalProperties = true;
if (process.argv[3] === "duplicate_action") tools.push(actionTool);
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
const progress = (attempted, acknowledged, in_flight = null) => ({ status: in_flight ? "unknown" : attempted.length ? "dispatched" : "refused",
  reason: in_flight ? "dom_action_dispatch_refused" : attempted.length ? null : "dom_action_trusted_unavailable",
  attempted_steps: attempted, acknowledged_steps: acknowledged, in_flight, mutation_attempted: attempted.length > 0,
  effects: "unverified", automatic_retry: false, cleanup: attempted.length ? "confirmed" : "not_started" });
function receipt(args, prefix, samples) {
  const refusal = !prefix.mutation_attempted ? { code: "browser_input_trust_unavailable", message: "Trusted route unavailable; no fallback" }
    : prefix.in_flight ? { code: "browser_route_unavailable", message: "Last native acknowledgement unavailable" } : null;
  return { format: "dom_action_v1", status: refusal ? "refused" : "dispatched", input_route: args.input_route,
    trusted: false, atomic: false, native_pixel_mapping: "unavailable", progress: prefix,
    action_result: { route: "dom", ...(prefix.mutation_attempted ? { effect: "unverifiable", delivery: { mode: "unknown" } }
      : { effect: "refused", error: { code: refusal.code, hint: refusal.message } }) }, observed: samples, refusal,
    limitations: ["programmatic_dom_semantics_only", "no_css_hover_proof", "no_trusted_key_defaults", "no_application_success_proof"] };
}
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state, isError = false;
  if (name === "fixture_identity") state = { identity: args.pid === 42 && args.window_id === 91 ? "fixture:91" : null };
  else if (name === "fixture_control") { outcome = args.operation; state = {}; }
  else if (name === "list_windows") state = { windows: [{ pid: 42, window_id: 91, app_name: "Chrome", title: "DOM action fixture" }] };
  else if (name === "start_session" || name === "end_session") state = { session: args.session, active: name === "start_session" };
  else if (name === "get_browser_state" && !args.snapshot_format) {
    if (args.pid !== 42 || args.window_id !== 91) throw Error("Unattested fixture window");
    state = { status: "ok", mode: "bind", binding_quality: "exact", endpoint_access_class: "driver_owned", target_id: "bt-action",
      tabs: [{ tab_id: "tab-action", active: true, title: "DOM action fixture", url: "http://127.0.0.1/fixture" }] };
  } else if (name === "get_browser_state") {
    if (args.target_id !== "bt-action" || args.tab_id !== "tab-action" || args.snapshot_format !== "dom_inspect_v1" || args.include_screenshot !== false)
      throw Error("Only exact-source image-free DOM collection is available");
    const snapshot = `p${++serial}`, reference = `${snapshot}:0`;
    snapshots.set(reference, args.session);
    state = { status: "ok", mode: "snapshot", target_id: args.target_id, tab_id: args.tab_id, page: { url: "http://127.0.0.1/fixture", title: "DOM action fixture" },
      snapshot: { id: snapshot, format: "dom_inspect_v1", complete: true, collection_complete: true, matched_count: 1, returned_count: 1, truncated: false,
        omitted: { nodes: 0, depth: 0, frames: 0, metadata: 0, text: 0, hidden_filtered: 0 }, scope: "document" },
      elements: [{ ref: reference, frame: { ref: "df-action", kind: "main" }, tag: "input", role: "textbox", name: "Name", value: "",
        text: "", text_truncated: false, attributes: { "data-testid": "name" }, states: { disabled: false }, visibility: "visible",
        bounds_css: null, coordinate_space: "document_css_pixels" }] };
  } else if (name === "browser_dom_action") {
    const keys = ["session", "target_id", "tab_id", "source_ref", "input_route", "request"];
    if (Object.keys(args).sort().join() !== keys.sort().join() || args.target_id !== "bt-action" || args.tab_id !== "tab-action" || snapshots.get(args.source_ref) !== args.session)
      throw Error("Action lost its exact private source context");
    snapshots.delete(args.source_ref);
    if (args.input_route === "trusted") state = receipt(args, progress([], []), []);
    else if (outcome === "unknown") state = receipt(args, progress(["click", "click", "dblclick"], ["click", "click"], "dblclick"),
      [{ step: "click", observed: { activation_invoked: true } }, { step: "click", observed: { activation_invoked: true } }]);
    else if (outcome === "diagnostic") { state = { code: "tool_invocation_failed", execution_state: "unknown", progress: progress(["click"], [], "click") }; isError = true; }
    else if (outcome === "malformed") { state = receipt(args, progress(["click"], ["click"]), [{ step: "click", observed: { activation_invoked: true } }]); state.backendNodeId = 777; }
    else {
      const steps = args.request.action === "fill" ? ["focus", "beforeinput", "fill", "input", "change"] : ["click"];
      state = receipt(args, progress(steps, steps), steps.map(step => ({ step, observed: step === "fill" ? { value_matches: true } : {} })));
    }
    outcome = "success";
  } else throw Error(`Unexpected native dispatch ${name}; no fallback backend exists`);
  return { structuredContent: state, isError, content: [{ type: "text", text: JSON.stringify(state) }] };
});
await server.connect(new StdioServerTransport());
