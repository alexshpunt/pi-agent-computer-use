import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Metadata-only preflight: no session, browser attachment, capture or UI input.
const command = process.env.CUA_DRIVER_PATH;
const expectedHash = process.env.CUA_DRIVER_SHA256;
assert.ok(command?.endsWith(".exe"), "Set CUA_DRIVER_PATH to the explicitly selected Windows driver.");
assert.match(expectedHash ?? "", /^[a-f0-9]{64}$/, "Set CUA_DRIVER_SHA256 to its independently recorded hash.");
assert.ok(process.env.WSL_INTEROP && (await stat(process.env.WSL_INTEROP)).isSocket(), "A live WSL interop socket is required.");
const sha256 = createHash("sha256").update(await readFile(command)).digest("hex");
assert.equal(sha256, expectedHash, "Driver bytes changed; do not silently qualify another runtime.");
const directory = `.tmp/lpt-732/preflight-${Date.now()}`;
await mkdir(directory, { recursive: true });
const transport = new StdioClientTransport({
  command, args: ["mcp", "--direct", "--embedded"], stderr: "pipe",
  env: {
    WSL_INTEROP: process.env.WSL_INTEROP,
    WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"].filter(Boolean).join(":"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", DO_NOT_TRACK: "1",
  },
});
let stderr = "";
transport.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
const client = new Client({ name: "pi-owned-browser-bridge-preflight", version: "0.0.0" });
try {
  await client.connect(transport, { timeout: 15_000 });
  const server = client.getServerVersion();
  assert.equal(server?.name, "cua-driver");
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools({ cursor }, { timeout: 15_000 });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await writeFile(`${directory}/tools.json`, JSON.stringify({ command, sha256, server, tools }, null, 2) + "\n");
  console.log(JSON.stringify({ directory, command, sha256, server, toolCount: tools.length,
    tools: tools.filter(tool => /browser|session|window_state|^page$/.test(tool.name)).map(tool => tool.name) }, null, 2));
} finally {
  try { await client.close(); }
  finally { await transport.close(); await writeFile(`${directory}/stderr.log`, stderr); }
}
