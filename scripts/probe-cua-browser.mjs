import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Opt-in, metadata-only probe for the separately qualified browser runtime.
// No session is created, window observed or UI input sent.
const command = process.env.CUA_DRIVER_PATH;
assert.ok(command?.endsWith(".exe"), "Set CUA_DRIVER_PATH to the separate Windows 0.33.2 executable.");
assert.ok(process.env.WSL_INTEROP && (await stat(process.env.WSL_INTEROP)).isSocket(), "A live WSL interop socket is required.");
const transport = new StdioClientTransport({
  command,
  args: ["mcp", "--direct", "--embedded"],
  stderr: "pipe",
  env: {
    WSL_INTEROP: process.env.WSL_INTEROP,
    WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"].filter(Boolean).join(":"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    DO_NOT_TRACK: "1",
  },
});
let stderr = "";
transport.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
const client = new Client({ name: "pi-cua-browser-preflight", version: "0.0.0" });
try {
  await client.connect(transport, { timeout: 15_000 });
  const server = client.getServerVersion();
  assert.equal(server?.name, "cua-driver");
  assert.equal(server.version, "0.33.2");
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools({ cursor }, { timeout: 15_000 });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await mkdir(".tmp/cua-pivot", { recursive: true });
  await writeFile(".tmp/cua-pivot/runtime-tools.json", JSON.stringify({ command, server, tools }, null, 2) + "\n");
  console.log(JSON.stringify({ command, server, toolCount: tools.length, browserTools: tools.filter(t => /browser|session|agent_cursor|zoom|window_state/.test(t.name)).map(t => t.name) }, null, 2));
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  try { await client.close(); }
  finally { await transport.close(); }
}
