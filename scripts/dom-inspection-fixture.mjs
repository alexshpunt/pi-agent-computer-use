import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { createDomInspectionPages } from "./fixtures/dom-inspection-pages.mjs";
import { closePixelProbeServer } from "./dom-native-pixel-contract.mjs";
import { nativeWindowState } from "./native-window-state.mjs";

// HTTP-only fixture for ordinary IDE verification. This helper never launches, navigates or inputs into a browser.
assert.deepEqual(process.argv.slice(2), ["--live-approved"]);
const directory = `.tmp/lpt-733/ordinary-${Date.now()}`, nonce = randomUUID(), marks = [];
await mkdir(directory, { recursive: true });
let fixture, stopping = false;
const servers = [createServer(), createServer()];
for (const server of servers) server.on("request", (request, response) => {
  if (!fixture) return void response.writeHead(503).end();
  void fixture.handle(request, response).catch(error => response.destroy(error));
});
const input = createInterface({ input: process.stdin });
const stop = () => { stopping = true; input.close(); };
const deadline = setTimeout(stop, 240_000);
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const save = () => writeFile(`${directory}/run.json`, JSON.stringify({ nonce, marks, status: fixture?.status(), reports: fixture?.reports() }, null, 2) + "\n");
try {
  for (const server of servers) await new Promise((resolve, reject) => {
    server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${servers[0].address().port}`, crossOrigin = `http://127.0.0.1:${servers[1].address().port}`;
  fixture = createDomInspectionPages({ nonce, origin, crossOrigin, transitionAfterMs: 90_000, maxReports: 2048 });
  if (stopping) throw Error("Fixture stopped during setup.");
  console.log(JSON.stringify({ ready: true, directory, url: `${origin}/`, title: `Pi DOM inspection ${nonce} root`, commands: "state, finish, or JSON {label,target:{pid,window_id}} for a readonly native mark" }));
  for await (const line of input) {
    if (stopping || line.trim() === "finish") break;
    try {
      if (line.trim() === "state") {
        await save(); console.log(JSON.stringify({ directory, status: fixture.status(), reports: fixture.reports().slice(-4) })); continue;
      }
      const command = JSON.parse(line);
      assert.equal(Object.keys(command).sort().join(","), "label,target");
      assert.ok(typeof command.label === "string" && /^[a-z0-9-]{1,48}$/.test(command.label));
      assert.equal(Object.keys(command.target).sort().join(","), "pid,window_id");
      assert.ok([command.target.pid, command.target.window_id].every(value => Number.isSafeInteger(value) && value > 0));
      assert.ok(marks.length < 24);
      const native = await nativeWindowState(process.env.WSL_INTEROP, [command.target]);
      const report = { label: command.label, native, status: fixture.status(), reports: fixture.reports().slice(-4) };
      marks.push(report); await save(); console.log(JSON.stringify({ directory, ...report }));
    } catch (error) { console.log(JSON.stringify({ error: String(error) })); process.exitCode = 1; break; }
  }
} finally {
  stopping = true; clearTimeout(deadline); input.close();
  const release = await Promise.allSettled(servers.map(closePixelProbeServer));
  await save(); console.log(JSON.stringify({ directory, server_cleanup: release.map(value => value.status), browser_cleanup: "Owned browser belongs to the ordinary computer session; close that session separately." }));
  if (release.some(value => value.status === "rejected")) process.exitCode = 1;
}
