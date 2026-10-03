import { mkdir, writeFile } from "node:fs/promises";
import { startBrowserFixture } from "../test/fixtures/browser-site.mjs";

// Opt-in local fixture for live parent Pi qualification. No LAN listener.
const fixture = await startBrowserFixture();
await mkdir(".tmp", { recursive: true });
await writeFile(".tmp/browser-fixture.json", JSON.stringify({ url: fixture.url, pid: process.pid }) + "\n");
console.log(fixture.url);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await fixture.close();
}
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
