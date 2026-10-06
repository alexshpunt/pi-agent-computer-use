import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openForkArtifact } from "./check-cua-fork-artifact.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { nativeInputState } from "./native-input-state.mjs";
import { createCompleteInputSite } from "../test/fixtures/complete-input-site.mjs";
import { loadComputerConfig } from "../src/config.ts";

// Opt-in native input only in newly created, isolated local fixtures. Never replay input.
assert.ok(process.argv.includes("--native"), "Pass --native to authorize disposable key-hold fixtures.");
const artifactDirectory = process.argv[2], source = process.argv[3];
const directory = `.tmp/key-holds/native-${Date.now()}`;
await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd());
const root = config.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "").replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const site = await createCompleteInputSite(), otherSite = await createCompleteInputSite();
const calls = [], records = []; let active, peer, fixture, other, success = false, cleanup;
const state = result => result.structuredContent;
const code = result => state(result)?.error?.code ?? state(result)?.code;
const record = (label, result) => {
  records.push({ label, state: state(result), isError: !!result.isError,
    text: result.content?.filter(block => block.type === "text").map(block => block.text) });
  return result;
};
const call = async (label, name, args) => {
  calls.push({label, name, args, time: Date.now()});
  return record(label, await active.call(name, args));
};
let installedApps;
const launcher = { call: async (name, args) => {
  // Reuse discovery made before any fixture launch; running Chrome adds dynamic app entries.
  if (name === "list_apps" && installedApps) return installedApps;
  const result = await peer.call(name, args);
  if (name === "list_apps") installedApps = result;
  return result;
} };
async function witness(predicate, label, timeout = 2000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const events = site.events(); if (predicate(events)) return events; await delay(20); }
  throw Error(`No native witness for ${label}; input was not replayed.`);
}
function physical(label) {
  const value = nativeInputState([16,17,18,87,91,92]); records.push({label, operation:"read_only_input_state", ...value}); return value;
}
function released(label) {
  const value = physical(label);
  assert.ok(!value.left_down && !value.right_down && !value.middle_down && Object.values(value.keys).every(down => !down), "Keys and buttons must be physically released.");
}
async function overview(label, target = fixture.target) {
  const result = await call(label, "get_window_state", {...target, max_image_dimension:500});
  assert.ok(!result.isError, JSON.stringify(records.at(-1)));
  const png = result.content.find(block => block.type === "image" && block.mimeType === "image/png");
  assert.ok(png, "Require an actual native overview PNG.");
  const bytes = Buffer.from(png.data,"base64"); await writeFile(`${directory}/${label}.png`, bytes);
  records.at(-1).image = {sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};
  return state(result);
}
function frame(view, label) {
  const elements = view.elements.filter(element => element.label === label && element.screenshot_frame);
  assert.equal(elements.length,1, `Require one native screenshot frame for ${label}.`); return elements[0].screenshot_frame;
}
function curve(view, duration_ms = 400, points = 9) {
  const r = frame(view,"Drawing board");
  const path = Array.from({length:points},(_,i)=>({x:r.x+r.w*(.15+.7*i/(points-1)), y:r.y+r.h*(.5+.28*Math.sin(2*Math.PI*i/(points-1)))}));
  return {action:"drag",from_x:path[0].x,from_y:path[0].y,via:path.slice(1,-1),to_x:path.at(-1).x,to_y:path.at(-1).y,duration_ms};
}
const hold = (keys, duration_ms, actions) => ({...fixture.target,keys,duration_ms,delivery_mode:"foreground",...(actions?{actions}: {})});
async function timed(keys,label) {
  await overview(`before-${label}`); const start = site.events().length;
  const result = await call(label,"hold_keys",hold(keys,500));
  assert.equal(state(result)?.effect,"unverifiable",JSON.stringify(records.at(-1)));
  assert.match(state(result).summary,/keys_released=true/);
  const events = (await witness(events=>events.slice(start).some(e=>e.type==="keyup"&&e.code==="KeyW"),label)).slice(start);
  for(const key of keys) {
    const code = key==="w"?"KeyW":"ShiftLeft";
    const down = events.find(e=>e.type==="keydown"&&e.code===code), up=events.find(e=>e.type==="keyup"&&e.code===code);
    assert.ok(down&&up,`Both transitions required for ${code}`); const elapsed=up.time-down.time;
    assert.ok(elapsed>=450 && elapsed<1500,`Actual held time ${elapsed}ms for requested 500ms; no real-time guarantee.`);
    records.push({label:`${label}-${code}`,requested_ms:500,actual_event_hold_ms:elapsed});
  }
  if(keys.length===2) assert.equal(events.find(e=>e.type==="keydown"&&e.code==="KeyW").shift,true);
  released(`${label}-released`);
}
try {
  released("before-input");
  active = await openForkArtifact(artifactDirectory,source); assert.equal(active.report.has_key_hold,true);
  peer = await openForkArtifact(artifactDirectory,source);
  fixture = await openCompleteInputWindow(launcher,site.url,root); await delay(4500);
  let view = await overview("initial");
  for(let n=0;n<8&&!view.elements.some(e=>e.label==="Drawing board"&&e.screenshot_frame);n++){await delay(300);view=await overview(`initial-${n}`);}
  const before = site.events().length;
  assert.equal(code(await call("background-refused","hold_keys",{...hold(["w"],500),delivery_mode:"background"})),"background_unavailable");
  assert.equal(code(await call("invalid-pointer-tail","hold_keys",hold(["shift"],500,[{action:"click",x:1,y:1},{action:"drag",from_x:1,from_y:2,to_x:3,to_y:4,duration_ms:501}]))),"hold_duration_exceeded");
  assert.equal(site.events().slice(before).filter(e=>e.type==="keydown").length,0);
  await timed(["w"],"w"); await timed(["w","shift"],"w-shift");

  view = await overview("before-pointer-hold"); const board=frame(view,"Drawing board"), pad=frame(view,"Pointer pad");
  const start = site.events().length;
  const actions=[{action:"click",x:pad.x+pad.w/2,y:pad.y+pad.h/2},
    {action:"drag",from_x:board.x+board.w*.2,from_y:board.y+board.h*.2,to_x:board.x+board.w*.7,to_y:board.y+board.h*.2,duration_ms:300},curve(view)];
  const pointer=await call("shift-pointer","hold_keys",hold(["shift"],1200,actions));
  assert.equal(state(pointer)?.effect,"unverifiable",JSON.stringify(records.at(-1)));
  assert.match(state(pointer).summary,/keys_released=true, pointer_actions=3\/3/);
  const events=(await witness(events=>events.slice(start).filter(e=>e.stroke).length===2,"held Shift pointer work")).slice(start);
  assert.ok(events.some(e=>e.type==="click"&&e.target==="pad"&&e.shift));
  assert.equal(events.filter(e=>e.type==="pointerdown"&&e.target==="board").length,2);
  assert.ok(events.filter(e=>e.type==="pointermove"&&e.target==="board").every(e=>e.shift&&e.buttons===1));
  view=await overview("after-pointer-hold"); assert.ok(view.elements.some(e=>e.label==="Shift selected")); released("pointer-released");

  // Another owned native peer can interrupt only these disposable fixtures.
  other = await openCompleteInputWindow(launcher,otherSite.url,root); await delay(4500);
  const peerView=await peer.call("get_window_state",{...fixture.target,max_image_dimension:500}); assert.ok(!peerView.isError);
  await overview("before-busy"); const busyStart=site.events().length;
  const running=call("busy-owner","hold_keys",hold(["w"],4000));
  await witness(events=>events.slice(busyStart).some(e=>e.type==="keydown"&&e.code==="KeyW"),"owner key down");
  const busy=record("busy-refused",await peer.call("hold_keys",hold(["w"],500)));
  assert.equal(code(busy),"input_busy",JSON.stringify(records.at(-1)));
  await running; released("busy-owner-released");

  view=await overview("before-foreground-loss"); const focusStart=site.events().length;
  const interrupted=call("foreground-loss","hold_keys",hold(["shift"],4000,[curve(view,3000,30)]));
  await witness(events=>events.slice(focusStart).some(e=>e.type==="pointerdown"&&e.target==="board"),"stroke before foreground loss");
  record("owned-foreground-change",await peer.call("bring_to_front",other.target));
  const stopped=await interrupted; assert.equal(state(stopped)?.effect,"partial",JSON.stringify(records.at(-1)));
  assert.match(state(stopped).summary,/keys_released=true.*foreground_lost/); released("foreground-loss-released");

  view=await overview("before-eof"); const eofStart=site.events().length;
  const pending=call("eof-pending","hold_keys",hold(["shift"],4000,[curve(view,3000,30)])).then(value=>({state:state(value)}),error=>({error:error.name}));
  await witness(events=>events.slice(eofStart).some(e=>e.type==="pointerdown"&&e.target==="board"),"hold before EOF");
  const closing=Date.now(); await active.close(); active=undefined; const elapsed=Date.now()-closing;
  records.push({label:"eof",elapsed_ms:elapsed,pending:await pending}); assert.ok(elapsed<2000,"EOF release must finish before the four-second hold"); released("eof-released");
  active=await openForkArtifact(artifactDirectory,source);

  view=await overview("before-abort"); const abortStart=site.events().length;
  const abort = new AbortController();
  const aborted=active.client.callTool({name:"hold_keys",arguments:hold(["shift"],4000,[curve(view,3000,30)])},undefined,{signal:abort.signal,timeout:15000})
    .then(value=>({state:state(value)}),error=>({error:error.name}));
  await witness(events=>events.slice(abortStart).some(e=>e.type==="pointerdown"&&e.target==="board"),"hold before AbortSignal");
  abort.abort(); const abortClosing=Date.now(); await active.close(); active=undefined;
  records.push({label:"abort-then-owned-eof",elapsed_ms:Date.now()-abortClosing,pending:await aborted}); released("abort-released");
  active=await openForkArtifact(artifactDirectory,source);
  await overview("before-target-close"); const closeStart=site.events().length;
  const closingHold=call("target-close","hold_keys",hold(["w"],4000));
  await witness(events=>events.slice(closeStart).some(e=>e.type==="keydown"&&e.code==="KeyW"),"hold before owned target close");
  const killed=record("owned-target-close",await peer.call("kill_app",{pid:fixture.target.pid})); assert.ok(!killed.isError);
  const closed=await closingHold; assert.equal(state(closed)?.effect,"partial",JSON.stringify(records.at(-1)));
  assert.match(state(closed).summary,/keys_released=true.*target_lost/); released("target-close-released");
  success=true;
} finally {
  try { cleanup={primary:await fixture?.close(),secondary:await other?.close()}; }
  finally {
    await active?.close();await peer?.close();await site.close();await otherSite.close();
    await writeFile(`${directory}/run.json`,JSON.stringify({success,source,calls,records,events:site.events(),cleanup,private_pixels:true},null,2));
  }
}
console.log(JSON.stringify({success,directory,calls:calls.length,records:records.length}));
