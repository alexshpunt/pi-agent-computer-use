import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi loads browser tools, forwards original PNG, refuses foreign input and releases stdio", async () => {
  await mkdir(".tmp",{recursive:true});
  const cwd=await mkdtemp(path.resolve(".tmp","browser-contract-"));
  try {
    const result=await new PiIntegrationTest({
      testName:"visible-browser-contract",artifactsDir:testArtifactsDir(import.meta.filename),cwd,
      extensions:[path.resolve("test/fixtures/browser-extension.ts")],
      tools:["browser_open","browser_act","browser_tabs","browser_close"],isolateUserResources:true,
      conversation:[
        assistantMessage([toolCall({id:"open",name:"browser_open",arguments:{url:"https://example.test"}})],{stopReason:"toolUse"}),
        assistantMessage([toolCall({id:"foreign",name:"browser_act",arguments:{page_ref:"foreign",observation_id:"stale",action:"fill",element_ref:"invented",text:"blocked"}})],{stopReason:"toolUse"}),
        assistantMessage([toolCall({id:"point",name:"browser_act",arguments:{page_ref:"foreign",observation_id:"stale",action:"click",x:10,y:20}})],{stopReason:"toolUse"}),
        assistantMessage([toolCall({id:"attach",name:"browser_open",arguments:{url:"https://example.test",profile:"personal"}})],{stopReason:"toolUse"}),
        assistantMessage([toolCall({id:"tabs",name:"browser_tabs",arguments:{}})],{stopReason:"toolUse"}),
        assistantMessage([toolCall({id:"close",name:"browser_close",arguments:{}})],{stopReason:"toolUse"}),
        assistantMessage([text("The owned browser contract was checked.")]),
      ],
    }).run("Open an owned browser page, refuse foreign input and personal profile arguments, then close.");
    expect(getToolExecutionDetails(getToolExecution(result,"open"))).toMatchObject({status:"observed",page_ref:expect.any(String),observation_id:expect.any(String)});
    expect(getToolExecutionResult(result,"open")).toMatchObject({content:expect.arrayContaining([expect.objectContaining({type:"image",mimeType:"image/png"})])});
    expect(getToolExecution(result,"foreign").isError).toBe(true);
    expect(getToolExecutionDetails(getToolExecution(result,"point"))).toMatchObject({status:"refused"});
    expect(getToolResultText(result,"point")).toContain("Stale, closed or foreign");
    expect(getToolExecution(result,"attach").isError).toBe(true);
    expect(getToolResultText(result,"close")).toContain("Owned browser closed");
    const calls=(await readFile(path.join(cwd,"browser-calls.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(calls.filter(call=>call.event==="open")).toHaveLength(1);
    expect(calls.some(call=>call.event==="input")).toBe(false);
    expect(calls).toContainEqual({event:"stdin-eof"});
    expect(result.tuiRenderedOutput).toContain("browser_open");
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
