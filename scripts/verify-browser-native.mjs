import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { BrowserClient } from "../src/browser-client.ts";
import { startBrowserFixture } from "../test/fixtures/browser-site.mjs";
import { browserNativeState } from "./browser-native-state.mjs";

// Opt-in fixed-code native check. Uses only new profiles and synthetic local pages.
const directory = ".tmp/browser-native";
await mkdir(directory, {recursive:true});
const fixture = await startBrowserFixture();
const client = new BrowserClient();
const records = [];
const call = async (operation, args={}, status="observed", signal) => {
  const result = await client.call(operation,args,signal);
  records.push({operation,args,details:result.details,isError:!!result.isError});
  assert.equal(result.details.status,status,JSON.stringify(result.details));
  return result;
};
const act = (r,action,extra={}) => call("act",{page_ref:r.details.page_ref,observation_id:r.details.observation_id,action,...extra});
const element = (r,name) => { const found=r.details.elements.find(e=>e.name===name); assert.ok(found,name); return found.element_ref; };
const image = async (r,name) => { const png=r.content.find(c=>c.type==="image"); assert.ok(png); await writeFile(directory+"/"+name+".png",Buffer.from(png.data,"base64")); };
const blank = r => assert.match(r.details.text,/Storage marker: absent; Cookie marker: absent/);
let slowServer;
let success=false;
try {
  let r=await call("open",{url:fixture.url});
  const first=r.details.page_ref;
  r=await act(r,"click",{element_ref:element(r,"Open message form")});
  blank(r);
  const stale={page_ref:first,observation_id:r.details.observation_id,action:"fill",element_ref:element(r,"Message"),text:"must not write"};
  r=await act(r,"fill",{element_ref:element(r,"Message"),text:"Pi visible browser"});
  await call("act",stale,"refused");
  r=await act(r,"click",{element_ref:element(r,"Submit message")});
  assert.match(r.details.text,/Confirmed: Pi visible browser/);
  assert.match(r.details.text,/Storage marker: Pi visible browser; Cookie marker: present/);
  await image(r,"confirmed");
  const active=await browserNativeState();
  assert.equal(active.browserCount,1); assert.equal(active.workerCount,1);
  assert.equal(active.listeners.length,0); assert.equal(active.profiles.length,1);
  assert.match(active.windows[0].commandLine,/--remote-debugging-pipe/);
  assert.doesNotMatch(active.windows[0].commandLine,/--no-sandbox|--disable-web-security|--remote-debugging-port/);
  records.push({operation:"native-active",details:active});
  r=await act(r,"scroll",{delta_y:1800});
  await image(r,"scrolled");
  r=await act(r,"click",{element_ref:element(r,"Open second tab")});
  const tabs=await call("tabs",{},"listed");
  const second=tabs.details.tabs.find(t=>t.title==="Pi browser second tab");
  assert.ok(second); assert.notEqual(second.page_ref,first);
  const secondState=await call("observe",{page_ref:second.page_ref});
  assert.match(secondState.details.text,/Second owned tab/);
  await image(secondState,"second-tab");
  await call("act",{page_ref:second.page_ref,observation_id:secondState.details.observation_id,action:"click",element_ref:element(r,"Back to start")},"refused");
  await call("observe",{page_ref:"foreign"},"refused");
  r=await call("observe",{page_ref:first});
  r=await act(r,"scroll",{delta_y:-2000});
  assert.match(r.details.text,/Confirmed: Pi visible browser/);
  await image(r,"returned");
  const closed=await client.close(); records.push({operation:"close",details:closed.details}); assert.equal(closed.details.status,"closed");
  await call("observe",{page_ref:first},"refused");
  r=await call("open",{url:fixture.url+"/form"});
  assert.notEqual(r.details.page_ref,first); blank(r);
  await image(r,"clean-profile");
  assert.equal((await client.close()).details.status,"closed");

  // Confirm cancellation AFTER native navigation reaches a server, without replaying it.
  let reached;
  const requested=new Promise(resolve=>{reached=resolve;});
  slowServer=http.createServer((_req,_res)=>{reached();});
  await new Promise(resolve=>slowServer.listen(0,"127.0.0.1",resolve));
  const controller=new AbortController();
  const pending=client.call("open",{url:"http://127.0.0.1:"+slowServer.address().port},controller.signal);
  await requested; controller.abort();
  const cancelled=await pending;
  assert.equal(cancelled.details.status,"unknown");
  records.push({operation:"cancelled-native-navigation",details:cancelled.details});
  assert.equal((await client.close()).details.status,"closed");
  success=true;
} finally {
  const closed=await client.close(); assert.equal(closed.details.status,"closed");
  slowServer?.closeAllConnections();
  if(slowServer) await new Promise(resolve=>slowServer.close(resolve));
  await fixture.close();
  const cleanup=await browserNativeState();
  records.push({operation:"native-cleanup",details:cleanup});
  assert.equal(cleanup.workerCount,0); assert.equal(cleanup.browserCount,0); assert.equal(cleanup.profiles.length,0);
  await writeFile(directory+"/run.json",JSON.stringify({success,records},null,2)+"\n");
}
console.log(JSON.stringify({success,operations:records.length,directory}));
