import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { createDomActionPages } from "./fixtures/dom-action-pages.mjs";
import { closePixelProbeServer } from "./dom-native-pixel-contract.mjs";

// HTTP-only live fixture. Browser launch, navigation, input and cleanup belong to the ordinary computer session.
assert.deepEqual(process.argv.slice(2), ["--live-approved"]);
const nonce = randomUUID(), directory = `.tmp/lpt-734/actions-${Date.now()}-${nonce}`;
await mkdir(directory, { recursive: true });
let pages, stopping = false;
const server = createServer((req, res) => {
  if (!pages) { res.writeHead(503).end(); return; }
  void pages.handle(req, res).catch(error => { res.destroy(error); });
});
const input = createInterface({ input: process.stdin });
const stop = () => { stopping = true; input.close(); };
const deadline = setTimeout(stop, 600000);
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const save = () => writeFile(`${directory}/run.json`, JSON.stringify({ nonce, status: pages?.status(), reports: pages?.reports() }, null, 2) + "\n");
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  pages = createDomActionPages({ nonce, origin });
  if (stopping) throw Error("Fixture stopped during setup.");
  await save();
  console.log(JSON.stringify({ ready: true, directory, url: `${origin}/`, title: `Pi DOM actions ${nonce}`,
    commands: "state or finish", async_timing_ms: { insert: 2000, replace: 3000, enable: 4000 }, lifetime_ms: 600000 }));
  for await (const line of input) {
    if (stopping || line.trim() === "finish") break;
    if (line.trim() !== "state") { process.exitCode = 1; console.error("Only state or finish is accepted."); break; }
    await save();
    console.log(JSON.stringify({ directory, status: pages.status(), latest: pages.reports().at(-1) ?? null }));
  }
} finally {
  stopping = true; clearTimeout(deadline); input.close();
  const cleanup = await Promise.allSettled([closePixelProbeServer(server)]);
  await save();
  console.log(JSON.stringify({ directory, server_cleanup: cleanup[0].status,
    browser_cleanup: "Close the owned ordinary computer session separately." }));
  if (cleanup[0].status === "rejected") process.exitCode = 1;
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
}
