#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Synthetic MCP peer for package startup/admission, not native GUI evidence.
const log = new URL("./calls.jsonl", import.meta.url);
const record = data => appendFileSync(log, JSON.stringify(data) + "\n");
const names = ["list_apps", "list_windows", "get_window_state", "get_desktop_state", "set_agent_cursor_motion", "get_agent_cursor_state"];
let glide = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  record({ method: request.method, args: process.argv.slice(2) });
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion,
    serverInfo: { name: "cua-driver", version: "0.34.0" },
    capabilities: { tools: {}, experimental: { "ai.cua.driver.envelopes": { version: 1 } } },
  };
  else if (request.method === "tools/list") result = { tools: names.map(name => ({ name, inputSchema: { type: "object" } })) };
  else if (request.method === "tools/call") {
    record({ tool: request.params.name });
    if (request.params.name === "set_agent_cursor_motion") glide = request.params.arguments.glide_duration_ms;
    result = request.params.name.includes("_agent_cursor_")
      ? { content: [], structuredContent: { motion: { glide_duration_ms: glide } } }
      : { content: [], structuredContent: { apps: [], environment: {
      envelopes: process.env.CUA_DRIVER_MCP_ENVELOPES,
      telemetry: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,
      display: process.env.DISPLAY,
    } } };
  }
  else throw new Error(`Unexpected fixture request: ${request.method}`);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}).on("close", () => { record({ eof: true }); process.exit(0); });
