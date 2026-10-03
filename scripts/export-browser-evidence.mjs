import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserNativeState } from "./browser-native-state.mjs";

// Offline export plus read-only cleanup check. Pass ONLY this qualification's own Pi session file.
const sessionFile=process.argv[2];
const revision=Number(process.argv[3]);
assert.ok(sessionFile && Number.isSafeInteger(revision) && revision>0,"Pass own session.jsonl and inspected pane revision.");
const native=JSON.parse(await readFile(".tmp/browser-native/run.json","utf8"));
const model=JSON.parse(await readFile(".tmp/browser-model/run.json","utf8"));
const fixture=JSON.parse(await readFile(".tmp/browser-fixture.json","utf8"));
const window=JSON.parse(await readFile(".tmp/browser-parent/actual-window.json","utf8"));
assert.equal(native.success,true); assert.equal(model.success,true);
const cleanup=await browserNativeState();
assert.equal(cleanup.workerCount,0); assert.equal(cleanup.browserCount,0); assert.equal(cleanup.profiles.length,0);
await assert.rejects(fetch(fixture.url,{signal:AbortSignal.timeout(2000)}),"Owned fixture server must be stopped.");
const rows=(await readFile(sessionFile,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
const messages=rows.filter(row=>row.type==="message" && row.message?.role==="toolResult" && row.message.toolName?.startsWith("browser_"))
  .map(row=>({...row.message,time:row.timestamp}));
const first=messages.find(message=>message.toolName==="browser_open" && message.details?.url===fixture.url+"/");
assert.ok(first);
const trace=messages.filter(message=>message.time>=first.time);
const observed=trace.filter(message=>message.details?.status==="observed");
const confirmed=observed.find(message=>message.details.text.includes("Confirmed: Pi visible browser"));
const second=observed.find(message=>message.details.title==="Pi browser second tab");
const returned=observed.findLast(message=>message.details.text.includes("Confirmed: Pi visible browser") && message.details.tabs.length===2);
const clean=observed.findLast(message=>message.toolName==="browser_open" && message.details.text.includes("Storage marker: absent; Cookie marker: absent"));
assert.ok(confirmed && second && returned && clean);
assert.notEqual(first.details.session_ref,clean.details.session_ref);
assert.ok(trace.filter(message=>message.details?.status==="refused").length>=3);
assert.ok(trace.some(message=>message.toolName==="browser_act" && message.details?.status==="closed"));
assert.equal(trace.at(-1).toolName,"browser_close"); assert.equal(trace.at(-1).details.status,"closed");
assert.match(window.target.title,/Pi browser form/);
assert.match(window.target.commandLine,/--remote-debugging-pipe/);
const tui=rows.find(row=>row.type==="message" && row.message?.role==="toolResult" && row.message.toolName==="inspect_tui" && row.message.details?.paneRevision===revision)?.message;
assert.ok(tui,"Inspected real viewport missing.");
const directory="docs/evidence/browser";
await mkdir(directory,{recursive:true});
const image=async (message,name)=>{
  const block=message.content.find(block=>block.type==="image" && block.mimeType==="image/png"); assert.ok(block,name);
  await writeFile(path.join(directory,name),Buffer.from(block.data,"base64"));
};
for(const [message,name] of [[confirmed,"parent-confirmed.png"],[second,"parent-second-tab.png"],[returned,"parent-returned.png"],[clean,"parent-clean-profile.png"],[tui,"parent-viewport.png"]]) await image(message,name);
await copyFile(".tmp/browser-parent/actual-window.png",path.join(directory,"actual-window.png"));
await copyFile(".tmp/browser-native/scrolled.png",path.join(directory,"native-scrolled.png"));
const compact=details=>({status:details.status,page_ref:details.page_ref,observation_id:details.observation_id,
  session_ref:details.session_ref,closed_session_ref:details.closed_session_ref,url:details.url,title:details.title,text:details.text,
  browser:details.browser,elapsed_ms:details.elapsed_ms,tabs:details.tabs,elements:details.elements});
const calls=rows.filter(row=>row.type==="message" && row.message?.role==="assistant").flatMap(row=>row.message.content.filter(block=>block.type==="toolCall"));
const argumentsById=new Map(calls.map(call=>[call.id,call.arguments]));
const output={success:true,parent:{sessionId:rows[0].id,viewport:tui.details,
  trace:trace.map(message=>({time:message.time,tool:message.toolName,args:argumentsById.get(message.toolCallId),
    details:compact(message.details),message:message.content.find(block=>block.type==="text")?.text.split("\n")[0]})),
  actualWindow:{pid:window.target.pid,window_id:window.target.window_id,title:window.target.title,commandLine:window.target.commandLine,
    listeners:window.metadata.listeners}},
  native:{operations:native.records.map(record=>({operation:record.operation,args:record.args,details:compact(record.details)})),
    cleanup:native.records.findLast(record=>record.operation==="native-cleanup").details},
  model:{model:model.model,tools:model.toolNames,rows:model.rows.map(row=>({tool:row.tool,details:compact(row.details),isError:row.isError})),cleanup:model.cleanup},
  cleanup:{...cleanup,fixtureStopped:true}};
await writeFile(path.join(directory,"run.json"),JSON.stringify(output,null,2)+"\n");
console.log(JSON.stringify({directory,parentCalls:trace.length,modelCalls:model.toolNames.length,cleanup}));
