import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { createPersistentWgcSite } from "../test/fixtures/persistent-wgc-site.ts";
import { openCompleteInputWindow } from "./complete-input-window.mjs";

// Own one finite fixture for production-tool observations/input. Stdin advances its marker or finishes it.
assert.equal(process.argv[2], "--owned-fixture");
const config = await loadComputerConfig(process.cwd());
assert.equal(config.runtime,"windows-persistent-wgc");
assert.ok(config.command.startsWith("/mnt/c/"));
const directory = path.resolve(`.tmp/wgc-integration/fixture-${Date.now()}`);
await mkdir(directory,{recursive:true});
const driver = new McpDriver(config);
let site, fixture;
const lines = createInterface({input:process.stdin,terminal:false});
const timeout = setTimeout(()=>lines.close(),1800000);
try {
  site = await createPersistentWgcSite();
  fixture = await openCompleteInputWindow(driver,site.url,"C:\\" + path.dirname(config.command).slice(7).replaceAll("/","\\"),
    ["--force-color-profile=srgb","--window-size=1050,750"]);
  const receipt = {directory,target:fixture.target,title:"Pi persistent WGC fixture",url:site.url};
  await writeFile(path.join(directory,"receipt.json"),JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify(receipt));
  for await (const line of lines) {
    if(line==="finish") break;
    if(line==="advance") console.log(JSON.stringify({revision:site.advance()}));
    else throw Error("Unknown fixture command; no replay");
  }
} finally {
  clearTimeout(timeout);lines.close();
  let cleanup;
  try {if(fixture) cleanup=await fixture.close();}
  finally {await driver.close();await site?.close();}
  console.log(JSON.stringify({directory,cleanup}));
}
