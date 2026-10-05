import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { CuaBrowser } from "../src/cua-browser.ts";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { createCuaBrowserSite } from "../test/fixtures/cua-browser-site.mjs";

// Own only a disposable local browser fixture. The running Pi exercises computer_* on its window.
const directory = `.tmp/region-highlights/parent-${Date.now()}`;
await mkdir(directory, {recursive:true});
const site = await createCuaBrowserSite();
const browser = new CuaBrowser(async()=>new McpDriver(await loadComputerConfig(process.cwd())));
let keepAlive;
try {
  const opened = await browser.call("open",{url:site.url});
  assert.equal(opened.details.status,"observed",opened.details.text);
  const native = opened.details.agent_image.native;
  const fixture = {directory,url:site.url,target:{pid:native.pid,window_id:native.window_id},title:"Pi CUA adapter fixture"};
  await writeFile(`${directory}/fixture.json`,JSON.stringify(fixture,null,2));
  console.log(JSON.stringify({phase:"parent-ready",...fixture}));
  let failure;
  keepAlive=setInterval(()=>{void browser.call("tabs",{}).catch(error=>{failure=error;});},5000);
  const prompt=createInterface({input:process.stdin,output:process.stdout});
  try {assert.equal((await prompt.question("Run the parent computer_* checks, then send finish: ")).trim(),"finish");}
  finally {prompt.close();}
  if(failure)throw failure;
} finally {
  clearInterval(keepAlive);
  const closed=await browser.call("close",{});
  await site.close();
  await writeFile(`${directory}/cleanup.json`,JSON.stringify(closed.details,null,2));
  assert.equal(closed.details.status,"closed");
}
console.log(JSON.stringify({phase:"closed",directory}));
