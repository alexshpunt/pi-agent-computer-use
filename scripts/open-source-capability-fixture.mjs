import { createInterface } from "node:readline";
import { createTemporalSite } from "../test/fixtures/temporal-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";

// Opt-in Windows fixture for production computer_* checks. Never use a personal browser profile.
// Run with node --experimental-transform-types; send finish after production verification.
const config = await loadComputerConfig(process.cwd());
const driver = new McpDriver(config);
const root = config.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "");
if (!root.startsWith("/mnt/c/")) throw Error("Expected the qualified Windows runtime's parent directory.");
const nativeRoot = root.replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const site = await createTemporalSite();
let fixture;
try {
  fixture = await openCompleteInputWindow(driver, site.url, nativeRoot);
  console.log(JSON.stringify({ title: "Pi temporal capture fixture", url: site.url }));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) { if (line.trim() === "finish") break; }
  input.close();
} finally {
  const cleanup = await fixture?.close();
  await driver.close(); await site.close();
  console.log(JSON.stringify({ cleanup }));
}
