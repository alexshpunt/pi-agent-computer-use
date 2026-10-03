import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserNativeState } from "./browser-native-state.mjs";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";

// Opt-in read-only capture of the ONE currently owned marked browser window. Never adopts desktop policy refs.
const directory=".tmp/browser-parent";
await mkdir(directory,{recursive:true});
const metadata=await browserNativeState();
assert.equal(metadata.browserCount,1,"Only one known owned browser is allowed for this capture.");
assert.equal(metadata.profiles.length,1);
const target=metadata.windows[0];
assert.ok(Number(target.window_id)>0,"Owned browser has no visible native window.");
const driver=new McpDriver(await loadComputerConfig(process.cwd()));
try {
  const result=await driver.call("get_window_state",{
    pid:target.pid,window_id:Number(target.window_id),max_elements:200,max_depth:15,timeout_ms:5000,max_image_dimension:1280,
  });
  assert.ok(!result.isError);
  const image=result.content.find(block=>block.type==="image");
  assert.ok(image,"Actual owned window screenshot missing.");
  const after=await browserNativeState();
  assert.ok(after.windows.some(window=>window.pid===target.pid && window.window_id===target.window_id),"Owned window changed during capture.");
  await writeFile(path.join(directory,"actual-window.png"),Buffer.from(image.data,"base64"));
  await writeFile(path.join(directory,"actual-window.json"),JSON.stringify({target,metadata,state:result.structuredContent},null,2)+"\n");
  console.log(JSON.stringify({target, image:path.join(directory,"actual-window.png")}));
} finally { await driver.close(); }
