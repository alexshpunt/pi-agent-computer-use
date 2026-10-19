import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { McpDriver } from "../src/driver.ts";
import { WindowIdentity, hostIdentityPeer } from "../src/window-identity.ts";
import { openForkArtifact } from "./check-cua-fork-artifact.mjs";
import { loadComputerConfig } from "../src/config.ts";
import { ComputerSession } from "../src/session.ts";
import { createCompleteInputSite } from "../test/fixtures/complete-input-site.mjs";

// Opt-in native input, only in this newly created local fixture. No retries or unrelated windows.
assert.ok(process.argv.includes("--native"), "Pass --native to authorize the disposable input fixture.");
const forkIndex = process.argv.indexOf("--fork-artifact");
const forkDirectory = forkIndex < 0 ? undefined : process.argv[forkIndex + 1];
const forkSource = forkIndex < 0 ? undefined : process.argv[forkIndex + 2];
if (forkIndex >= 0) { assert.ok(forkDirectory); assert.match(forkSource ?? "", /^[0-9a-f]{40}$/); }
const directory = forkDirectory ? `.tmp/cua-drag-fork/compat-${Date.now()}` : `.tmp/cua-gestures/native-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd()), site = await createCompleteInputSite();
async function createBackend() {
  if (!forkDirectory) return new McpDriver(config);
  const artifact = await openForkArtifact(forkDirectory, forkSource);
  const identity = new WindowIdentity(hostIdentityPeer(config.interop ?? process.env.WSL_INTEROP));
  return { call: artifact.call, identity: (...args) => identity.identify(...args),
    close: async () => { try { await artifact.close(); } finally { await identity.close(); } } };
}
const backend = await createBackend(); const calls = [], records = [];
const driver = { identity: (...args) => backend.identity(...args), close: () => backend.close(),
  async call(name,args,signal) { calls.push({name,args,time:Date.now()}); return backend.call(name,args,signal); } };
const session = new ComputerSession(driver); let ref, target, fixture, success = false;
async function save(label, result, status = "observed") {
  records.push({label,details:result.details}); assert.equal(result.details.status,status,JSON.stringify(result.details));
  const image = result.content.find(c => c.type === "image");
  if(image) {const bytes = Buffer.from(image.data,"base64"); await writeFile(`${directory}/${label}.png`,bytes);
    records.at(-1).image={hash:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};}
  return result.details;
}
const observe = label => session.observe(ref).then(result => save(label,result));
function point(view, label) {
  const rows = view.state.elements.filter(e => e.label === label && e.screenshot_frame);
  assert.equal(rows.length,1,`One native screenshot frame required for ${label}`);
  const r=rows[0].screenshot_frame; return {x:r.x+r.w/2,y:r.y+r.h/2,frame:r,token:rows[0].element_token};
}
async function send(label, view, command, targetLabel) {
  let result = await session.act({window_ref:ref,observation_id:view.observation_id,...command});
  if (result.details.status === "refused" && ["background_unavailable", "background_occluded"].includes(result.details.state?.code)) {
    await save(`${label}-background-refused`, result, "refused");
    view = await observe(`${label}-before-explicit-foreground`);
    if (command.x !== undefined) {
      assert.ok(targetLabel, "Reground a pixel target after a refusal.");
      const target = point(view, targetLabel); command = { ...command, x: target.x, y: target.y };
    }
    result = await session.act({window_ref:ref,observation_id:view.observation_id,...command,delivery_mode:"foreground"});
  }
  return save(label,result,"delivered");
}
async function witness(predicate,label) {
  for(let n=0;n<12;n++) {const events=site.events();if(predicate(events))return events;await delay(100);}
  throw Error(`Native receipt did not establish ${label}; no input was replayed.`);
}
try {
  const root=config.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/,"").replace("/mnt/c/","C:\\").replaceAll("/","\\");
  fixture=await openCompleteInputWindow(driver,site.url,root); target=fixture.target;
  // Let the owned launch's <=3s asynchronous foreground restoration finish before input.
  await delay(4500);
  const listed=await session.windows(undefined,"Pi complete input fixture");
  const windows=listed.details.state.windows.filter(w=>w.pid===target.pid&&w.window_id===target.window_id);
  assert.equal(windows.length,1);ref=windows[0].window_ref;
  let view=await observe("initial");
  for(let n=0;n<8&&!view.state.elements.some(e=>e.label==="Message"&&e.screenshot_frame);n++) {
    await delay(500);view=await observe(`initial-readonly-${n}`);
  }
  const field=point(view,"Message");
  await send("focus-field",view,{action:"click",x:field.x,y:field.y},"Message");
  view=await observe("before-keyboard");
  const keyboardSteps=[
    {action:"key",key:"a"},{action:"hotkey",keys:["shift","b"],wait_ms:100},
    {action:"type_text",text:"xyz",delay_ms:40},{action:"key",key:"left"},{action:"key",key:"right",wait_ms:100},
  ];
  let keyboardResult=await session.act({window_ref:ref,observation_id:view.observation_id,action:"sequence",sequence:keyboardSteps});
  if(keyboardResult.details.status==="refused"&&keyboardResult.details.state?.code==="background_unavailable"&&keyboardResult.details.state.sequence.completed===0) {
    await save("background-keyboard-refused",keyboardResult,"refused");view=await observe("before-explicit-foreground-keyboard");
    keyboardResult=await session.act({window_ref:ref,observation_id:view.observation_id,action:"sequence",sequence:keyboardSteps,delivery_mode:"foreground"});
  }
  const keyboard=await save("keyboard",keyboardResult,"delivered");
  assert.equal(keyboard.state.sequence.completed,5);
  const keys=await witness(events=>events.some(e=>e.type==="input"&&e.value.endsWith("xyz")),"literal typed suffix");
  // Physical key letters follow the user's active layout; do not switch it or assume Latin text.
  for(const code of ["KeyA","KeyB","ArrowLeft","ArrowRight"]) {
    assert.ok(keys.some(e=>e.type==="keydown"&&e.code===code),`Missing keydown ${code}`);
    assert.ok(keys.some(e=>e.type==="keyup"&&e.code===code),`Missing keyup ${code}`);
  }
  assert.ok(keys.some(e=>e.type==="keydown"&&e.code==="KeyB"&&e.shift===true));
  assert.ok(keys.some(e=>e.type==="keyup"&&e.code==="ShiftLeft"&&e.shift===false));
  await observe("after-keyboard");
  for(const action of ["right_click","double_click"]) {
    view=await observe(`before-${action}`);const pad=point(view,"Pointer pad");const before=site.events().length;
    await send(action,view,{action,x:pad.x,y:pad.y},"Pointer pad");
    await witness(events=>events.slice(before).some(e=>e.type===(action==="right_click"?"contextmenu":"dblclick")),action);
  }
  view=await observe("before-scroll");let scroll=point(view,"Scroll area");
  let scrollResult=await session.act({window_ref:ref,observation_id:view.observation_id,action:"scroll",element_token:scroll.token,direction:"down",amount:2,by:"line"});
  if(scrollResult.details.status==="refused"&&scrollResult.details.state?.code==="background_unavailable") {
    await save("background-scroll-refused",scrollResult,"refused");view=await observe("before-explicit-foreground-scroll");scroll=point(view,"Scroll area");
    scrollResult=await session.act({window_ref:ref,observation_id:view.observation_id,action:"scroll",element_token:scroll.token,direction:"down",amount:2,by:"line",delivery_mode:"foreground"});
  }
  await save("scroll",scrollResult,"delivered");
  await witness(events=>events.some(e=>e.type==="scroll"&&e.scrollTop>0),"scroll");
  const strokesFor=view=>{
    const board=point(view,"Drawing board").frame;
    const p={x:board.x+board.w*0.2,y:board.y+board.h*0.25};
    const q={x:board.x+board.w*0.65,y:p.y}; const r={x:q.x,y:board.y+board.h*0.7};
    return [[p,q],[q,r],[r,p]].map(([a,b])=>({action:"drag",from_x:a.x,from_y:a.y,to_x:b.x,to_y:b.y,duration_ms:250,steps:10,button:"left"}));
  };
  view=await observe("before-drawing");
  let drawing=await session.act({window_ref:ref,observation_id:view.observation_id,action:"sequence",sequence:strokesFor(view)});
  if(drawing.details.status==="refused"&&drawing.details.state?.code==="background_unavailable"&&drawing.details.state.sequence.completed===0) {
    await save("background-drawing-refused",drawing,"refused");view=await observe("before-explicit-foreground-drawing");
    drawing=await session.act({window_ref:ref,observation_id:view.observation_id,action:"sequence",sequence:strokesFor(view),delivery_mode:"foreground"});
  }
  await save("independent-strokes",drawing,"delivered");
  const events=await witness(events=>events.filter(e=>e.stroke).length===3,"three independent strokes");
  const downs=events.filter(e=>e.type==="pointerdown"&&e.target==="board"),ups=events.filter(e=>e.stroke);
  assert.equal(downs.length,3);assert.equal(ups.length,3);
  for(let i=0;i<3;i++){assert.ok(downs[i].time<ups[i].time);if(i<2)assert.ok(ups[i].time<downs[i+1].time);}
  const last=await observe("after-drawing");assert.ok(last.state.elements.some(e=>e.label==="Strokes: 3"));
  success=true;
} finally {
  const closed=fixture?await fixture.close():undefined; await session.close(); await site.close();
  const cleanupBackend=await createBackend();let sourceGone;
  try {const current=await cleanupBackend.call("list_windows",{});sourceGone=!(current.structuredContent?.windows??[]).some(w=>w.pid===target?.pid&&w.window_id===target?.window_id);}
  finally {await cleanupBackend.close();}
  await writeFile(`${directory}/run.json`,JSON.stringify({success,target,calls,records,events:site.events(),cleanup:{browser:closed,sourceGone,fixture:true,session:true},private_pixels:true},null,2));
  if(success){assert.equal(closed.sourceGone,true);assert.equal(sourceGone,true);}
}
console.log(JSON.stringify({success,directory,calls:calls.length,records:records.length,events:site.events().length}));
