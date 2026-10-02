import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Read-only capability probe. It never observes a desktop or dispatches UI input.
const command = process.env.CUA_DRIVER_PATH;
if (!command) throw new Error("Set CUA_DRIVER_PATH to the Windows cua-driver.exe path visible from WSL.");
const forwarded = ["CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"];
const transport = new StdioClientTransport({
  command,
  args: ["mcp", "--direct", "--embedded"],
  stderr: "pipe",
  env: {
    ...(process.env.WSL_INTEROP ? { WSL_INTEROP: process.env.WSL_INTEROP } : {}),
    WSLENV: [process.env.WSLENV, ...forwarded].filter(Boolean).join(":"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
    DO_NOT_TRACK: "1",
  },
});
transport.stderr.on("data", (chunk) => process.stderr.write(chunk));
const client = new Client({ name: "pi-computer-use-capability-probe", version: "0.0.0" });
try {
  await client.connect(transport, { timeout: 15_000 });
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools({ cursor }, { timeout: 15_000 });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  await mkdir(".tmp", { recursive: true });
  await writeFile(".tmp/driver-tools.json", JSON.stringify({ server: client.getServerVersion(), tools }, null, 2) + "\n");
  console.log(JSON.stringify({ server: client.getServerVersion(), toolCount: tools.length, tools: tools.map((t) => t.name) }, null, 2));
} finally {
  await client.close();
  await transport.close();
}
