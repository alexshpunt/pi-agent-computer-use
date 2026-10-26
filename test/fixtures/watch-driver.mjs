import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentCursor } from "./agent-cursor.mjs";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// A window of 1000x640 with a red square on a lane: a drag moves the square along with the pointer over its duration,
// like a panorama panned by dragging. Every driver process started with the same log shares the drag through a state
// file, so a second process captures the square while the first one is still dragging.
const log = process.argv[2], shared = `${log}.drag.json`;
const window = { width: 1000, height: 640 };
const bounds = { x: 80, y: 90, ...window };
const server = new Server({ name: "cua-driver", version: "0.33.2" }, { capabilities: { tools: {} } });
const drag = () => { try { return JSON.parse(readFileSync(shared, "utf8")); } catch { return undefined; } };
/** Where the square is now, in window pixels: at the drag's start before it, moving with it, at its end after it. */
function square() {
  const d = drag();
  if (!d) return 100;
  const progress = Math.min(1, Math.max(0, (Date.now() - d.start) / Math.max(1, d.duration)));
  return Math.round(d.from + (d.to - d.from) * progress);
}
async function capture(cap) {
  const scale = Math.min(1, (cap ?? 4096) / Math.max(window.width, window.height));
  const x = square();
  const full = await sharp({ create: { ...window, channels: 3, background: "white" } })
    .composite([{ input: { create: { width: 60, height: 60, channels: 3, background: "red" } }, left: Math.min(window.width - 60, x), top: 170 }]).png().toBuffer();
  const width = Math.round(window.width * scale), height = Math.round(window.height * scale);
  return { png: scale === 1 ? full : await sharp(full).resize(width, height).png().toBuffer(), width, height };
}
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }) => {
  const cursor = agentCursor(name, args); if (cursor) return cursor;
  appendFileSync(log, JSON.stringify({ name, arguments: args, pid: process.pid, at: Date.now() }) + "\n");
  let state; let image;
  if (name === "fixture_identity") state = { identity: `owned:${args.window_id}` };
  else if (name === "list_windows") state = { windows: [{ pid: 42, window_id: 91, bounds, title: "Watch fixture" }] };
  else if (name === "get_window_state") {
    const shot = await capture(args.max_image_dimension);
    state = { pid: 42, window_id: 91, window_bounds: bounds, screenshot_width: shot.width, screenshot_height: shot.height,
      screenshot_original_width: window.width, screenshot_original_height: window.height, capture_id: `capture-${Date.now()}`,
      elements_complete: true, elements: [] };
    if (args.include_screenshot !== false) image = shot.png;
  } else if (name === "drag") {
    const duration = args.duration_ms ?? 500;
    writeFileSync(shared, JSON.stringify({ start: Date.now(), duration, from: args.from_x, to: args.to_x }));
    await new Promise(resolve => setTimeout(resolve, duration));
    state = { effect: "confirmed", delivery: { mode: "foreground" } };
  } else throw Error(`Unexpected native call ${name}`);
  return { structuredContent: state, content: [{ type: "text", text: JSON.stringify(state) },
    ...(image ? [{ type: "image", mimeType: "image/png", data: image.toString("base64") }] : [])] };
});
await server.connect(new StdioServerTransport());
