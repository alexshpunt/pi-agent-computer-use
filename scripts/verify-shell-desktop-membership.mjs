import assert from "node:assert/strict";
import http from "node:http";
import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";

// Opt-in disposable fixture setup. The owner places/switches only these windows on existing desktops.
// Production computer_* tools do the measured reads; this runner never switches or moves desktops.
assert.equal(process.argv[2], "--live-approved", "Owner approval is required for this live fixture.");
const config = await loadComputerConfig(process.cwd());
assert.equal(config.runtime, "windows-shell-desktops", "Use the exact separately qualified candidate.");
const directory = `.tmp/lpt-624/live-${Date.now()}`;
await mkdir(directory, { recursive: true });
const driver = new McpDriver(config);
const nativeRoot = dirname(config.command).replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const server = http.createServer((request, response) => {
  const index = /^\/([12])$/.exec(request.url ?? "")?.[1];
  if (!index) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><meta charset="utf-8"><title>Pi shell desktop fixture ${index}</title>
<style>body{font:24px system-ui;padding:30px;background:${index === "1" ? "#dde6ff" : "#daf3dd"}}</style>
<h1>DESKTOP FIXTURE ${index}</h1><p>Disposable LPT-624 membership marker.</p>
<p>The owner places this window on an existing Task View desktop.</p><p>No document or account data.</p>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const fixtures = [];
let serial = 0;
const sample = async () => {
  const result = await driver.call("list_windows", {});
  assert.ok(!result.isError, "Native discovery failed.");
  const windows = result.structuredContent.windows.filter(window => fixtures.some(f =>
    f.target.pid === window.pid && f.target.window_id === window.window_id));
  const record = { sampled_at: new Date().toISOString(), windows };
  await writeFile(`${directory}/native-${++serial}.json`, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
};
try {
  for (let n = 1; n <= 2; n++) fixtures.push(await openCompleteInputWindow(driver, `${url}/${n}`, nativeRoot));
  const manifest = { directory, url, source: "506239da08cfdafa63dac1857f5471752fb70f5e", runtime: config.runtime,
    fixtures: fixtures.map((f, index) => ({ title: `Pi shell desktop fixture ${index + 1}`, target: f.target, profile: f.profile })) };
  await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ directory, url, titles: manifest.fixtures.map(f => f.title) }));
  console.log("Owned fixtures ready. Owner placement/switch/move only; commands: state, finish. Never change workspace before cleanup.");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line.trim() === "finish") break;
    if (line.trim() === "state") await sample();
    else console.log("Unknown fixture command; no action.");
  }
  input.close();
} finally {
  const cleanup = [];
  try { for (const fixture of fixtures.reverse()) cleanup.push(await fixture.close()); }
  finally { await driver.close(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(`${directory}/cleanup.json`, JSON.stringify(cleanup, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
}
