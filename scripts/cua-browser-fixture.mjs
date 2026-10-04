import { mkdir, writeFile } from "node:fs/promises";
import { createCuaBrowserSite } from "../test/fixtures/cua-browser-site.mjs";

// Local synthetic surface for the parent Pi's owned native CUA browser.
const site = await createCuaBrowserSite();
await mkdir(".tmp/cua-pivot", { recursive: true });
await writeFile(".tmp/cua-pivot/fixture.json", JSON.stringify({ url: site.url, pid: process.pid }) + "\n");
console.log(site.url);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await site.close(); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
