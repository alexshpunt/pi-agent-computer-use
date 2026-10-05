import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import sharp from "sharp";
import { ComputerSession } from "../src/session.ts";
import { McpDriver } from "../src/driver.ts";
import { loadComputerConfig } from "../src/config.ts";
import { CuaBrowser } from "../src/cua-browser.ts";
import { WindowOverlay } from "../src/window-overlay.ts";
import { startOverlayPeer } from "../src/window-overlay-peer.ts";
import { createCuaBrowserSite } from "../test/fixtures/cua-browser-site.mjs";

// Opt-in native checks. Private desktop pixels and lifetime markers stay in ignored .tmp.
assert.ok(process.argv.includes("--allow-primary-display"), "Explicit primary-display permission is required.");
const command = process.env.PI_WINDOW_OVERLAY_PATH;
assert.ok(command?.endsWith("/pi-window-overlay.exe"), "Set the trusted built helper path.");
const directory = `.tmp/region-highlights/native-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const backend = new McpDriver(config);
const calls = []; const frames = []; const records = [];
let nativeSession; let peer; let target; let ownedRef; let success = false;
const driver = {
  async call(name, args, signal) { calls.push({name, args}); nativeSession = args.session ?? nativeSession; return backend.call(name, args, signal); },
  identity: (...args) => backend.identity(...args), close: () => backend.close(),
};
const overlay = new WindowOverlay(async () => {
  peer = await startOverlayPeer(command, [], config.interop);
  const send = peer.send.bind(peer);
  peer.send = async request => { const reply = await send(request); records.push({label:"helper-reply",reply}); return reply; };
  return peer;
});
const observer = async (frame, signal) => { frames.push(frame); return overlay.flash(frame, signal); };
const session = new ComputerSession(driver, undefined, undefined, observer);
const browser = new CuaBrowser(async () => new McpDriver(config));
const site = await createCuaBrowserSite();
const inspect = () => {
  const script = String.raw`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
Add-Type 'using System; using System.Runtime.InteropServices; public class RegionState {
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }';
$p=Get-Process -Id ${peer.ready.pid} -ErrorAction SilentlyContinue;
@{visible=[RegionState]::IsWindowVisible([IntPtr]${peer.ready.overlay_hwnd});
foreground=[RegionState]::GetForegroundWindow().ToInt64(); helper_present=($null-ne$p);
source_present=[RegionState]::IsWindow([IntPtr]${target.window_id})}|ConvertTo-Json -Compress`;
  return JSON.parse(execFileSync("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    {encoding:"utf8",timeout:10000,stdio:["ignore","pipe","pipe"]}));
};
async function save(label, result, expected = "observed") {
  records.push({label, details:result.details});
  assert.equal(result.details.status, expected, JSON.stringify(result.details));
  const image = result.content.find(b => b.type === "image");
  if (image) await writeFile(`${directory}/${label}.${image.mimeType === "image/jpeg" ? "jpg" : "png"}`, Buffer.from(image.data,"base64"));
  return result.details;
}
async function desktopRegion(label, bounds) {
  const result = await driver.call("get_desktop_state", {session:nativeSession,max_image_dimension:0});
  assert.ok(!result.isError); const image = result.content.find(b=>b.type==="image"); assert.ok(image);
  const bytes = Buffer.from(image.data,"base64"); await writeFile(`${directory}/${label}.png`,bytes);
  return sharp(bytes).extract({left:bounds.x,top:bounds.y,width:bounds.width,height:bounds.height}).raw().toBuffer();
}
try {
  const opened = await browser.call("open", {url:site.url});
  assert.equal(opened.details.status,"observed",opened.details.text);
  target = {pid:opened.details.agent_image.native.pid,window_id:opened.details.agent_image.native.window_id};
  const found = await session.windows(undefined,"Pi CUA adapter fixture");
  const windows = found.details.state.windows.filter(w=>w.pid===target.pid && w.window_id===target.window_id);
  assert.equal(windows.length,1); ownedRef = windows[0].window_ref;
  const overview = await save("window-overview",await session.observe(ownedRef));
  assert.equal(overview.highlight.status,"shown");
  const windowFrame = frames.at(-1); assert.ok("target" in windowFrame);
  const bounds = windowFrame.bounds;
  const {width,height} = overview.source.image.dimensions;
  const zoom = await save("window-detail",await session.observe(ownedRef,undefined,undefined,
    {image_id:overview.agent_image.image_id,x:width*0.15,y:height*0.25,width:width*0.4,height:height*0.25}));
  assert.equal(zoom.highlight.status,"shown",JSON.stringify(zoom.highlight));
  assert.equal(zoom.highlight.kind,"detail"); assert.ok(!zoom.observation_id);
  const detailFrame = frames.at(-1);
  const display = await save("display-overview",await session.observeDisplay("primary"));
  assert.equal(display.highlight.status,"shown"); const displayFrame = frames.at(-1);
  const original = display.source.image.original_dimensions;
  assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=original.width && bounds.y+bounds.height<=original.height);
  const d = display.source.image.dimensions;
  const cropped = await save("display-crop",await session.observeDisplay("primary",undefined,
    {image_id:display.agent_image.image_id,x:bounds.x*d.width/original.width,y:bounds.y*d.height/original.height,
      width:bounds.width*d.width/original.width,height:bounds.height*d.height/original.height,maxLongEdge:1200,scale:1}));
  assert.equal(cropped.highlight.status,"shown"); assert.equal(cropped.highlight.kind,"detail");
  const cropFrame = frames.at(-1);

  // Show every renderer primitive on a settled static owned page, without input replay.
  await overlay.clear(); await delay(250);
  const baseline = await desktopRegion("hidden",bounds);
  assert.deepEqual(await desktopRegion("hidden-stable",bounds),baseline,"Static fixture pixels must settle first.");
  const actionRegion = { ...windowFrame,mark:{kind:"action",region:detailFrame.mark.region} };
  const actionPoint = { ...windowFrame,mark:{kind:"action",point:{x:bounds.x+Math.floor(bounds.width/2),y:bounds.y+Math.floor(bounds.height/2)}} };
  const styles = [windowFrame,detailFrame,displayFrame,cropFrame,actionRegion,actionPoint];
  for (const [i,frame] of styles.entries()) {
    assert.equal((await overlay.flash(frame)).status,"shown");
    // Compare focus within the native show operation, not across unrelated human actions.
    const reply = records.at(-1).reply;
    assert.equal(reply.focus_unchanged,true); assert.equal(reply.foreground_unchanged,true);
    assert.equal(inspect().visible,true);
    await overlay.flash(frame);
    assert.deepEqual(await desktopRegion(`excluded-${i}`,bounds),baseline,"Human marks must not enter CUA pixels.");
    records.push({label:`renderer-${i}`,kind:frame.mark?.kind??"overview",focus_unchanged:true,identical_owned_region_pixels:true});
  }
  await delay(2150); assert.equal(inspect().visible,false); records.push({label:"expired",visible:false});
  assert.equal((await overlay.flash({...detailFrame,bounds:{...bounds,width:bounds.width+1}})).status,"unavailable");
  assert.equal(inspect().visible,false); records.push({label:"stale-geometry",visible:false});

  let fresh = await save("before-ax-action",await session.observe(ownedRef));
  const button = fresh.state.elements.filter(e=>e.label==="One" && e.role?.toLowerCase()==="button" && e.actions?.includes("invoke"));
  assert.equal(button.length,1);
  const ax = await save("ax-action",await session.act({window_ref:ownedRef,observation_id:fresh.observation_id,action:"click",element_token:button[0].element_token}),"delivered");
  assert.equal(ax.highlight.status,"shown"); assert.ok(ax.highlight.region);
  fresh = await save("after-ax-action",await session.observe(ownedRef));
  assert.ok(fresh.state.elements.some(e=>e.label==="Selections: 1"));
  const second = fresh.state.elements.filter(e=>e.label==="Two" && e.screenshot_frame);
  assert.equal(second.length,1); const r=second[0].screenshot_frame;
  const point = await save("pixel-action",await session.act({window_ref:ownedRef,observation_id:fresh.observation_id,action:"click",x:r.x+r.w/2,y:r.y+r.h/2}),"delivered");
  assert.equal(point.highlight.status,"shown"); assert.ok(point.highlight.point);
  const after = await save("after-pixel-action",await session.observe(ownedRef)); assert.ok(after.state.elements.some(e=>e.label==="Selections: 2"));
  assert.equal(calls.filter(c=>c.name==="click").length,2,"Exactly two planned actions, no retries.");

  if (process.argv.includes("--human")) {
    console.log(JSON.stringify({phase:"human-check",directory,target,helper:peer.ready,styles:["cyan overview","amber detail/crop","pink action target"]}));
    let error; let index=0;
    const pulse=setInterval(()=>{void overlay.flash(styles[index++%styles.length]).catch(e=>{error=e;});},1500);
    const keepAlive=setInterval(()=>{void browser.call("tabs",{}).catch(e=>{error=e;});},5000);
    const prompt=createInterface({input:process.stdin,output:process.stdout});
    try { assert.equal((await prompt.question("Check the real colored regions; send finish when done: ")).trim(),"finish"); }
    finally {clearInterval(pulse);clearInterval(keepAlive);prompt.close();}
    if(error)throw error;
  }
  success=true;
} finally {
  try {await overlay.close();} finally {try {await browser.call("close",{});} finally {await session.close();await site.close();}}
  const cleanup=peer&&target?inspect():undefined;
  await writeFile(`${directory}/run.json`,JSON.stringify({success,calls,frames,records,cleanup,private_pixels:true},null,2));
  if(success){assert.equal(cleanup.helper_present,false);assert.equal(cleanup.source_present,false);}
}
console.log(JSON.stringify({success,directory,records:records.length,calls:calls.length}));
