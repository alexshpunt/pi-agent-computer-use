import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Synthetic MCP only: no browser process, native capture or input backend exists here.
const log = process.argv[2];
const identities = new Map([[91, "fixture:91"], [92, "fixture:92"], [93, "fixture:93"]]);
let serial = 0, outcome = "success";
const snapshots = new Map();
const properties = {
  snapshot_format: { type: "string", enum: ["dom_inspect_v1"] },
  locator: { type: "object", additionalProperties: false,
    properties: Object.fromEntries(["role", "name", "label", "text", "test_id", "css"].map(key => [key, { type: "string" }])) },
  scope_ref: { type: "string" }, include_hidden: { type: "boolean" },
  geometry_ref: { type: "string", minLength: 1, maxLength: 256 },
  max_nodes: { type: "integer", minimum: 1, maximum: 200 }, max_depth: { type: "integer", minimum: 1, maximum: 32 },
  screenshot_mode: { type: "string", enum: ["viewport", "surface_unclipped", "native_view"] },
};
const tools = ["start_session", "end_session", "list_windows", "get_window_state", "fixture_identity", "fixture_control"].map(name => ({
  name, inputSchema: { type: "object", properties: {} },
}));
tools.push({ name: "get_browser_state", inputSchema: { type: "object", properties } });
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state;
  if (name === "fixture_identity") state = { identity: identities.get(args.window_id) };
  else if (name === "fixture_control") {
    if (args.operation === "reuse") identities.set(args.window_id, "replacement");
    else if (args.operation === "close") identities.delete(args.window_id);
    else outcome = args.operation;
    state = {};
  } else if (name === "list_windows") state = { windows: [...identities.keys()].map(window_id => ({ pid: 42, window_id,
    app_name: "Chrome", title: `Readonly DOM fixture ${window_id}` })) };
  else if (name === "start_session" || name === "end_session") state = { session: args.session, active: name === "start_session" };
  else if (name === "get_window_state") {
    if (!identities.has(args.window_id) || args.include_screenshot !== false) throw Error("Only exact-source UI-only reads are available");
    state = { pid: 42, window_id: args.window_id, snapshot_id: `ui-${++serial}`, elements: [], elements_complete: true };
  } else if (name === "get_browser_state" && !args.snapshot_format) {
    if (!identities.has(args.window_id)) throw Error("Closed native source");
    state = { status: "ok", mode: "bind", binding_quality: "exact", endpoint_access_class: "driver_owned",
      target_id: `bt-${args.window_id}`, tabs: [{ tab_id: `tab-${args.window_id}`, active: true,
        title: `Readonly DOM fixture ${args.window_id}`, url: "http://127.0.0.1/fixture" }] };
    if (outcome === "ambiguous_binding") { state.tabs.push({ ...state.tabs[0], tab_id: "other", active: true }); outcome = "success"; }
    else if (outcome === "foreign_profile") { state.endpoint_access_class = "existing_profile"; outcome = "success"; }
  } else if (name === "get_browser_state" && args.geometry_ref !== undefined) {
    const allowed = ["target_id", "tab_id", "session", "snapshot_format", "geometry_ref"];
    if (args.snapshot_format !== "dom_inspect_v1" || Object.keys(args).some(key => !allowed.includes(key)))
      throw Error("Geometry accepts only one current readonly source, never collection or capture options");
    const current = snapshots.get(args.target_id), row = current?.rows.find(row => row.ref === args.geometry_ref);
    if (!row || args.tab_id !== current.tab || row.frame.kind !== "main")
      state = { status: "refused", refusal: { code: row ? "browser_route_unavailable" : "browser_ref_stale" } };
    else {
      state = { status: "ok", mode: "element_geometry", target_id: args.target_id, tab_id: args.tab_id,
        ref: args.geometry_ref, source_ref: args.geometry_ref, frame: { kind: "main" },
        coordinate_space: "frame_viewport_css_pixels", viewport: "layout", method: "isolated_cssom_border_box",
        native_pixel_mapping: "unavailable", atomic: false, connected: true, same_document: true,
        bounds: { x: 10.25, y: 20.5, width: 90, height: 30 }, scroll: { x: 0, y: 120 },
        visual_viewport: { offset_x: 0, offset_y: 0, page_x: 0, page_y: 120, width: 800, height: 600, scale: 1 } };
      if (outcome === "wrong_geometry_source") state.tab_id = "foreign";
    }
    outcome = "success";
  } else if (name === "get_browser_state") {
    if (args.include_screenshot !== false || args.snapshot_format !== "dom_inspect_v1") throw Error("Only explicit readonly DOM snapshots are available");
    const id = `p${++serial}`;
    const row = (index, fields = {}) => ({ ref: `${id}:${index}`, frame: { ref: "df-main", kind: "main" }, tag: "button",
      attributes: { "data-testid": `advance-${index}` }, text: "Advance", text_truncated: false, role: "button", name: "Advance", value: null,
      states: { disabled: false }, visibility: "visible", bounds_css: { x: 10 + index * 20, y: 20, width: 90, height: 30 },
      coordinate_space: "document_css_pixels", ...fields });
    let rows = [row(0), row(1, { frame: { ref: "df-frame", kind: "iframe" } }), row(2, { tag: "input", role: "checkbox", name: "Enabled",
      text: "", value: "live value", states: { disabled: false, checked: true }, attributes: { "data-testid": "enabled", "aria-label": "Enabled" } })];
    if (args.include_hidden) rows.push(row(3, { visibility: "hidden", bounds_css: null, text: "Hidden metadata" }));
    if (args.scope_ref) rows = [rows[1]];
    if (args.locator?.role) rows = rows.filter(row => row.role === args.locator.role);
    const matched = rows.length;
    rows = rows.slice(0, args.max_nodes ?? 200);
    snapshots.set(args.target_id, { tab: args.tab_id, rows });
    state = { status: "ok", mode: "snapshot", target_id: args.target_id, tab_id: args.tab_id,
      page: { url: "http://127.0.0.1/fixture", title: "Readonly DOM fixture" },
      snapshot: { id, format: "dom_inspect_v1", complete: false, collection_complete: false, matched_count: matched,
        returned_count: rows.length, truncated: rows.length < matched, scope: args.scope_ref ? "subtree" : "document",
        omitted: { nodes: 0, depth: 0, frames: 1, metadata: 0, text: 0, hidden_filtered: 0 } }, elements: rows };
    if (outcome === "wrong_target") state.tab_id = "foreign";
    else if (outcome === "missing_metadata") delete rows[0].attributes;
    else if (outcome === "input_authority") rows[0].actions = ["click"];
    else if (outcome === "bad_counts") state.snapshot.returned_count = 199;
    else if (outcome === "refused") state = { status: "refused", refusal: { code: "browser_ref_stale" } };
    outcome = "success";
  } else throw Error(`Unexpected native dispatch ${name}; no input, capture or browser preparation fallback exists`);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) }] };
});
await server.connect(new StdioServerTransport());
