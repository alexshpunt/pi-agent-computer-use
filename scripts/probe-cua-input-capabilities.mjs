import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadComputerConfig } from "../src/config.ts";

// Opt-in metadata-only probe. No input, screenshot, browser or app is requested.
const directory = ".tmp/input-capabilities/native";
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const transport = new StdioClientTransport({ command: config.command,
  args: config.args ?? ["mcp", "--direct", "--embedded"], stderr: "pipe",
  env: { WSL_INTEROP: config.interop ?? process.env.WSL_INTEROP,
    WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"].filter(Boolean).join(":"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", DO_NOT_TRACK: "1" } });
const client = new Client({ name: "pi-cua-input-capability-probe", version: "0.0.0" });
try {
  await client.connect(transport, { timeout: 15000 });
  const server = client.getServerVersion();
  assert.deepEqual(server, { name: "cua-driver", version: "0.33.2" });
  const tools = []; let cursor;
  do {
    const page = await client.listTools({ cursor }, { timeout: 15000 });
    tools.push(...page.tools); cursor = page.nextCursor;
  } while (cursor);
  const names = tools.map(tool => tool.name);
  const input = tools.filter(tool => /key|type|hotkey|click|drag|scroll|cursor|mouse|pointer|interactive/.test(tool.name) || tool.name === "page");
  const report = { server, platform: "windows-host-from-wsl", toolCount: tools.length,
    inputCalls: 0, screenshotCalls: 0, tools: input.map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations })),
    missing: ["key_down", "key_up", "mouse_button_down", "mouse_button_up", "mouse_drag", "parallel_mouse_drag", "browser_key"].filter(name => !names.includes(name)) };
  await writeFile(`${directory}/run.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ success: true, server, toolCount: tools.length,
    inputTools: input.map(tool => tool.name), missing: report.missing, inputCalls: 0, screenshotCalls: 0,
    schemaHash: createHash("sha256").update(JSON.stringify(report.tools)).digest("hex"), directory }));
} finally {
  try { await client.close(); } finally { await transport.close(); }
}
