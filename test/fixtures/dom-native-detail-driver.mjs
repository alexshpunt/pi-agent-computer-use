import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A synthetic MCP peer only. No native process, desktop capture or input backend exists.
const log = process.argv[2], target = { pid: 42, window_id: 91 };
const binding = { target_id: "bt-private-detail", tab_id: "tab-private-detail" };
const browser = { product: "Chrome/155.0.8059.40", revision: "@tested-fixture" };
const frame = { x: 70, y: 61, width: 1330, height: 949 };
const physical = { x: 86, y: 221, width: 19, height: 16 };
const png = await sharp({ create: { width: 19, height: 16, channels: 4, background: { r: 24, g: 48, b: 96, alpha: 1 } } }).png().toBuffer();
const pixelHash = createHash("sha256").update(png).digest("hex");
let serial = 0, geometryCalls = 0, reference, changeAfterCrop = false, changed = false;
const properties = {
  snapshot_format: { type: "string", enum: ["dom_inspect_v1"] },
  locator: { type: "object", additionalProperties: false,
    properties: Object.fromEntries(["role", "name", "label", "text", "test_id", "css"].map(key => [key, { type: "string" }])) },
  scope_ref: { type: "string" }, include_hidden: { type: "boolean" },
  geometry_ref: { type: "string", minLength: 1, maxLength: 256 },
  native_geometry_ref: { type: "string", minLength: 1, maxLength: 256 },
  max_nodes: { type: "integer", minimum: 1, maximum: 200 }, max_depth: { type: "integer", minimum: 1, maximum: 32 },
  screenshot_mode: { type: "string", enum: ["viewport", "surface_unclipped", "native_view"] },
};
const tools = ["start_session", "end_session", "list_windows", "fixture_identity", "fixture_control"].map(name => ({ name, inputSchema: { type: "object", properties: {} } }));
tools.push({ name: "get_browser_state", inputSchema: { type: "object", properties } },
  { name: "zoom", inputSchema: { type: "object", required: ["window_id", "x1", "y1", "x2", "y2"], additionalProperties: false,
    properties: { pid: { type: "integer", minimum: 1, maximum: 2147483647 }, window_id: { type: "integer", minimum: 1 },
      session: { type: "string" }, capture_backend: { type: "string", enum: ["default", "wgc"] },
      ...Object.fromEntries(["x1", "y1", "x2", "y2"].map(key => [key, { type: "number" }])) } } });
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  appendFileSync(log, JSON.stringify({ name, arguments: args }) + "\n");
  let state, images = [];
  if (name === "fixture_identity") {
    if (args.pid !== target.pid || args.window_id !== target.window_id) throw Error("Foreign synthetic window");
    state = { identity: `PiComputerUse.${"a".repeat(32)}:42:1` };
  } else if (name === "fixture_control") {
    if (args.operation === "change_after_crop") changeAfterCrop = true;
    else if (args.operation !== "describe") throw Error("Unknown fixture control");
    state = { pixel_hash: pixelHash, width: 19, height: 16 };
  } else if (name === "list_windows") state = { windows: [{ ...target, app_name: "Chrome", title: "Native DOM detail fixture" }] };
  else if (name === "start_session" || name === "end_session") state = { session: args.session, active: name === "start_session" };
  else if (name === "get_browser_state" && !args.snapshot_format) {
    if (args.pid !== target.pid || args.window_id !== target.window_id) throw Error("Foreign binding target");
    state = { status: "ok", mode: "bind", binding_quality: "exact", endpoint_access_class: "driver_owned", ...binding,
      tabs: [{ tab_id: binding.tab_id, active: true, title: "Native DOM detail fixture", url: "http://127.0.0.1/detail" }] };
  } else if (name === "get_browser_state" && args.native_geometry_ref !== undefined) {
    if (args.target_id !== binding.target_id || args.tab_id !== binding.tab_id || args.native_geometry_ref !== reference ||
      Object.keys(args).sort().join() !== ["native_geometry_ref", "session", "snapshot_format", "tab_id", "target_id"].sort().join()) throw Error("Foreign or expanded geometry request");
    state = { format: "native_dom_geometry_v1", status: "ok", mode: "native_element_geometry", ...binding,
      ref: reference, source_ref: reference,
      source: { frame_id: "frame-private", loader_id: changed ? "replaced-loader" : "loader-private", backend_node_id: 9,
        context_unique_id: `private-context-${++geometryCalls}`, generation: 2 }, frame: { kind: "main" },
      css_sample: { connected: true, same_document: true, bounds: { x: 10.5, y: 20.25, width: 12, height: 10 },
        scroll: { x: 0, y: 300.5 }, layout_viewport: { width: 886, height: 546, dpr: 1.5 },
        visual_viewport: { offset_x: 0, offset_y: 0, page_x: 0, page_y: 300.5, width: 886, height: 546, scale: 1 } },
      native: { platform: "windows", ...target, window: { x: 60, y: 60, width: 1350, height: 960 }, viewport: { x: 71, y: 191, width: 1329, height: 819 },
        source: "uia_root_web_area", automation_id: "RootWebArea", framework: "Chrome", opaque_runtime_id: [42, -7, 12] },
      physical_enclosing_rect: physical, clipped: false, coordinate_space: "screen_physical_pixels", browser_version: browser,
      projection: "root_origin_plus_floor_start_ceil_end_at_sampled_dpr", qualification: "candidate_not_raster_qualified", atomic: false, input_authority: false };
  } else if (name === "get_browser_state") {
    if (args.snapshot_format !== "dom_inspect_v1" || args.include_screenshot !== false || args.target_id !== binding.target_id || args.tab_id !== binding.tab_id)
      throw Error("Only exact readonly DOM collection is available");
    const id = `p${++serial}`; reference = `${id}:0`;
    state = { status: "ok", mode: "snapshot", ...binding, page: { url: "http://127.0.0.1/detail", title: "Native DOM detail fixture" },
      snapshot: { id, format: "dom_inspect_v1", complete: true, collection_complete: true, matched_count: 1, returned_count: 1, truncated: false,
        scope: "document", omitted: { nodes: 0, depth: 0, frames: 0, metadata: 0, text: 0, hidden_filtered: 0 } },
      elements: [{ ref: reference, frame: { ref: "df-main", kind: "main" }, tag: "button", attributes: { "data-testid": "advance" }, text: "Advance",
        text_truncated: false, role: "button", name: "Advance", value: null, states: {}, visibility: "visible", bounds_css: null, coordinate_space: "document_css_pixels" }] };
  } else if (name === "zoom") {
    const expected = { ...target, session: args.session, capture_backend: "wgc", x1: 86, y1: 221, x2: 105, y2: 237 };
    if (Object.keys(args).sort().join() !== Object.keys(expected).sort().join() || Object.entries(expected).some(([key, value]) => args[key] !== value) || !args.session)
      throw Error("Nonexact WGC crop or legacy capture fallback");
    state = { kind: "wgc_crop_v1", ...target, coordinate_space: "screen_physical", frame_bounds: frame, source_dimensions: { width: 1330, height: 949 },
      crop_bounds: physical, crop_offset: { x: 16, y: 160 }, width: 19, height: 16, format: "png", mime_type: "image/png", scale: 1, padding: 0,
      input_authority: false, paint_freshness: "unverified", capture_metadata: { backend: "wgc", paint_freshness: "unverified", frame_bounds: frame,
        wait_ms: 2, readback_ms: 1, dequeue_to_copy_ms: 1, reported_frame_age_at_copy_ms: -1, frame_timestamp_100ns: 120000, dequeued_100ns: 100000,
        copy_completed_100ns: 110000, frame_after_request_ms: 1, discarded: 0, recreations: 0, resources_reused: true, setup_ms: 0 } };
    images = [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }];
    if (changeAfterCrop) changed = true;
  } else throw Error(`Unexpected dispatch ${name}; no input, browser preparation or alternate capture backend exists`);
  return { structuredContent: state, content: [...images, { type: "text", text: JSON.stringify(state) }] };
});
await server.connect(new StdioServerTransport());
