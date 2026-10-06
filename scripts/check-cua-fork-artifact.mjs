import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Open exact CI artifact bytes without installing them. Opening only performs MCP discovery. */
export async function openForkArtifact(directory, source) {
  directory = resolve(directory);
  assert.match(source ?? "", /^[0-9a-f]{40}$/, "Pass the expected source commit after the artifact directory.");
  assert.equal((await readFile(resolve(directory, "source-sha.txt"), "utf8")).trim(), source);
  const hashes = JSON.parse(await readFile(resolve(directory, "hashes.json"), "utf8"));
  for (const entry of hashes) {
    const actual = createHash("sha256").update(await readFile(resolve(directory, "runtime", entry.name))).digest("hex");
    assert.equal(actual, entry.Hash.toLowerCase(), `Artifact hash mismatch: ${entry.name}`);
  }
  const transport = new StdioClientTransport({
    command: resolve(directory, "runtime/cua-driver.exe"),
    args: ["mcp", "--direct", "--embedded"],
    stderr: "pipe",
    env: {
      ...process.env,
      WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "CUA_DRIVER_MCP_ENVELOPES", "DO_NOT_TRACK"].filter(Boolean).join(":"),
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
      // The upstream receiver observes EOF while a legacy tools/call is active.
      // Its default serial loop cannot do that; SDK shutdown could kill a hold.
      CUA_DRIVER_MCP_ENVELOPES: "1",
      DO_NOT_TRACK: "1",
    },
  });
  const client = new Client({ name: "pi-cua-fork-artifact-check", version: "0.0.0" });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const close = async () => { try { await client.close(); } finally { await transport.close(); } };
  try {
    await client.connect(transport, { timeout: 15000 });
    const server = client.getServerVersion();
    assert.equal(server?.name, "cua-driver");
    assert.equal(server.version, (await readFile(resolve(directory, "version.txt"), "utf8")).trim().replace(/^cua-driver /, ""));
    assert.equal(client.getServerCapabilities()?.experimental?.["ai.cua.driver.envelopes"]?.version, 1,
      "The exact candidate must acknowledge the upstream EOF-aware receiver.");
    const { tools } = await client.listTools(undefined, { timeout: 15000 });
    for (const name of ["list_windows", "get_window_state", "zoom", "click", "drag"]) assert.ok(tools.some(tool => tool.name === name), `Missing native tool: ${name}`);
    const report = { source, server, binary_sha256: hashes.find(entry => entry.name === "cua-driver.exe").Hash.toLowerCase(), tools: tools.length, transport: "upstream_mcp_envelopes", has_drag_via: !!tools.find(tool => tool.name === "drag")?.inputSchema.properties?.via, has_key_hold: tools.some(tool => tool.name === "hold_keys") };
    return { report, close, client, transport, diagnostics: () => stderr,
      call: (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 15000 }) };
  } catch (error) {
    await close();
    throw new Error(`Artifact check failed: ${error.message}\n${stderr}`, { cause: error });
  }
}

// Direct execution is harmless: no app launch, input or capture.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const artifact = await openForkArtifact(process.argv[2] ?? "", process.argv[3]);
  try { console.log(JSON.stringify({ success: true, ...artifact.report, input_calls: 0, capture_calls: 0 })); }
  finally { await artifact.close(); }
}
