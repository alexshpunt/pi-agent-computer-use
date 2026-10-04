import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { WindowIdentity } from "../src/window-identity.ts";
import { ComputerSession } from "../src/session.ts";
import { CuaBrowser } from "../src/cua-browser.ts";
import { createCuaBrowserSite } from "../test/fixtures/cua-browser-site.mjs";

// Opt-in qualification before changing production pins. Screenshots stay in ignored storage.
const command = process.env.CUA_DRIVER_PATH;
assert.ok(command?.endsWith("/cua-driver-0.33.2/cua-driver.exe"));
const directory = ".tmp/native-zoom/qualification";
await mkdir(directory, { recursive: true });
const transport = new StdioClientTransport({ command, args: ["mcp", "--direct", "--embedded"], stderr: "pipe",
  env: { WSL_INTEROP: process.env.WSL_INTEROP,
    WSLENV: [process.env.WSLENV, "CUA_DRIVER_RS_TELEMETRY_ENABLED", "CUA_DRIVER_RS_UPDATE_CHECK", "DO_NOT_TRACK"].filter(Boolean).join(":"),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false", CUA_DRIVER_RS_UPDATE_CHECK: "false", DO_NOT_TRACK: "1" } });
const client = new Client({ name: "pi-cua-runtime-qualification", version: "0.0.0" });
const identities = new WindowIdentity(process.env.WSL_INTEROP);
const calls = [];
const driver = {
  async call(name, args, signal) {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 15000, signal }));
    calls.push({ name, args, isError: result.isError ?? false });
    await writeFile(`${directory}/calls.json`, JSON.stringify(calls, null, 2));
    return { content: result.content.filter(block => ["text", "image"].includes(block.type)), structuredContent: result.structuredContent, isError: result.isError };
  },
  identity: (target, create, signal) => identities.identify(target, create, signal),
  close: () => identities.close(),
};
async function save(name, result) {
  assert.equal(result.details.status, "observed", JSON.stringify(result.details));
  const block = result.content.find(block => block.type === "image"); assert.ok(block);
  await writeFile(`${directory}/${name}.${block.mimeType === "image/jpeg" ? "jpg" : "png"}`, Buffer.from(block.data, "base64"));
  return result.details;
}
const desktop = new ComputerSession(driver);
const browser = new CuaBrowser(async () => driver);
let site;
let owned;
try {
  await client.connect(transport, { timeout: 15000 });
  assert.deepEqual(client.getServerVersion(), { name: "cua-driver", version: "0.33.2" });
  const tools = []; let cursor;
  do { const page = await client.listTools({ cursor }, { timeout: 15000 }); tools.push(...page.tools); cursor = page.nextCursor; } while (cursor);
  await writeFile(`${directory}/tools.json`, JSON.stringify({ server: client.getServerVersion(), tools }, null, 2));
  console.log(JSON.stringify({ phase: "metadata", server: client.getServerVersion(), tools: tools.length,
    screenTools: tools.filter(t => /desktop|zoom|screen/.test(t.name)).map(t => ({ name: t.name, inputSchema: t.inputSchema })) }));
  if (!process.argv.includes("--allow-primary-display")) process.exitCode = 0;
  else {
    await save("display", await desktop.observeDisplay("primary"));
    const opened = await desktop.open("Calculator"); owned = opened.details.window_ref;
    const state = await save("calculator", opened);
    const closer = state.state.elements.find(element => /close calculator/i.test(element.label));
    assert.ok(closer, "A grounded disposable Calculator Close control is required.");
    const closed = await desktop.act({ window_ref: owned, observation_id: state.observation_id, action: "click", element_token: closer.element_token });
    assert.equal(closed.details.status, "delivered");
    const found = await desktop.windows(undefined, "Calculator");
    assert.ok(!found.details.state.windows.some(window => window.window_ref === owned), "Calculator must be gone."); owned = undefined;
    site = await createCuaBrowserSite();
    let stateBrowser = await save("browser-open", await browser.call("open", { url: site.url }));
    const hint = name => { const targets = stateBrowser.elements.filter(e => e.name === name); assert.equal(targets.length, 1); return targets[0].hint; };
    const previous = hint("One");
    for (const name of ["One", "Two", "Three", "Four"]) assert.equal((await browser.call("act", { click: hint(name), observe: false })).details.status, "acted");
    stateBrowser = await save("browser-four", await browser.call("observe", {})); assert.ok(stateBrowser.text.includes("Selections: 4"));
    const before = calls.length; assert.equal((await browser.call("act", { click: previous, observe: false })).details.status, "refused"); assert.equal(calls.length, before);
    await save("browser-zoom", await browser.call("observe", { zoom: { x: 20, y: 40, width: 200, height: 100 } }));
    stateBrowser = await save("browser-after-zoom", await browser.call("observe", {}));
    assert.equal((await browser.call("act", { fill: hint("Message"), text: "Pi runtime qualification 407", observe: false })).details.status, "acted");
    assert.equal((await browser.call("act", { click: hint("Submit"), observe: false })).details.status, "acted");
    stateBrowser = await save("browser-submitted", await browser.call("observe", {})); assert.ok(stateBrowser.text.includes("Submitted: Pi runtime qualification 407"));
    assert.equal((await browser.call("close", {})).details.status, "closed");
    stateBrowser = await save("browser-reopened", await browser.call("open", { url: site.url })); assert.ok(stateBrowser.text.includes("Previous fixture storage: empty"));
    assert.equal((await browser.call("close", {})).details.status, "closed");
    await writeFile(`${directory}/run.json`, JSON.stringify({ success: true, version: "0.33.2", calls, display: "private PNG not exported", calculatorClosed: true, staleHintDispatches: 0 }, null, 2));
    console.log(JSON.stringify({ phase: "native", success: true, directory, calls: calls.length }));
  }
} finally {
  if (owned) console.error("Owned Calculator cleanup needs grounded observation; target ref:", owned);
  try { await browser.call("close", {}); } finally {
    await desktop.close(); await site?.close();
    try { await client.close(); } finally { await transport.close(); }
  }
}
