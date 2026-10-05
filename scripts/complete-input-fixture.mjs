import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createCompleteInputSite } from "../test/fixtures/complete-input-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";

// Hold one disposable native window for live production-tool verification. Send finish to clean it.
assert.ok(process.argv.includes("--native"), "Pass --native for the owned local input fixture.");
const directory = `.tmp/cua-gestures/parent-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd()), driver = new McpDriver(config);
const site = await createCompleteInputSite(); let fixture;
try {
  const root = config.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "").replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
  fixture = await openCompleteInputWindow(driver, site.url, root);
  const info = { directory, ...fixture.target, title: "Pi complete input fixture", url: site.url };
  await writeFile(`${directory}/fixture.json`, JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) { if (line.trim() === "finish") break; }
  input.close();
} finally {
  const cleanup = fixture ? await fixture.close() : undefined;
  await driver.close(); await site.close();
  await writeFile(`${directory}/run.json`, JSON.stringify({ events: site.events(), cleanup, private_fixture: true }, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
}
