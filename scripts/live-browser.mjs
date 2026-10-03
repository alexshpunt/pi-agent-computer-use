import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolCallNames, getToolExecutionDetails, getToolExecutionResult, getToolExecutions, PiIntegrationTest } from "pi-coding-agent-test";
import { startBrowserFixture } from "../test/fixtures/browser-site.mjs";
import { browserNativeState } from "./browser-native-state.mjs";

// Opt-in real-model Pi qualification. Isolated resources, no IDE, shell, desktop input or personal browser.
const root=process.cwd();
await mkdir(".tmp",{recursive:true});
const cwd=await mkdtemp(path.join(root,".tmp/native-browser-"));
const directory=path.join(root,".tmp/browser-model");
await mkdir(directory,{recursive:true});
const fixture=await startBrowserFixture();
let success=false;
let summary={};
try {
  const result=await new PiIntegrationTest({
    testName:"native-visible-browser",artifactsDir:path.join(root,".tmp/native-runs"),cwd,
    extensions:[path.join(root,"src/index.ts")],
    tools:["browser_open","browser_observe","browser_act","browser_tabs","browser_close"],
    providerMode:"user",isolateUserResources:true,rawMode:false,timeoutMs:300_000,
  }).run(`Qualify the visible agent browser using ONLY the five supplied browser tools.
Use only these synthetic local URLs, never personal browsers, external websites, accounts, downloads, uploads or arbitrary JavaScript.
1. Open ${fixture.url} with browser_open. Verify owned visible page text AND original screenshot.
2. Follow the observed Open message form link. Verify Storage marker: absent; Cookie marker: absent.
3. Fill the observed Message field with exactly Pi visible browser. Submit through the observed Submit message button.
Verify Confirmed: Pi visible browser AND the original screenshot, with storage/cookie markers now present.
Every action needs this page's CURRENT observation_id and element_ref from returned state. An action returns a fresh observation so do not add unnecessary reads.
4. Scroll down to the Lower page section and visually check it. Follow observed Open second tab.
List owned tabs and observe/select the second tab. Verify its text and PNG show Second owned tab.
5. Return to the FIRST page_ref through browser_observe, scroll back to the top and verify the same confirmation and original pixels.
6. Make ONE deliberate browser_observe with page_ref foreign-test-reference to verify refusal. This must not attach to anything.
7. Close the whole owned browser using browser_close. Open ${fixture.url}/form again.
Verify a NEW session/page ref and both storage and cookie markers absent. Close this new session too.
Report exact results and limits honestly. Unknown input is not replayed: read fresh tabs/state before deciding.
The human sees the same owned browser window, not a mirror. Never alter desktop Safe/YOLO.`);
  const executions=getToolExecutions(result);
  const rows=executions.map(execution=>({tool:execution.toolName,callId:execution.toolCallId,
    details:getToolExecutionDetails(execution),isError:execution.isError}));
  const observed=rows.filter(row=>row.details?.status==="observed");
  assert.ok(observed.some(row=>row.details.text?.includes("Confirmed: Pi visible browser")));
  assert.ok(observed.some(row=>row.details.title==="Pi browser second tab"));
  const clean=observed.filter(row=>row.details.text?.includes("Storage marker: absent; Cookie marker: absent"));
  assert.ok(new Set(clean.map(row=>row.details.session_ref)).size>=2,"Second clean profile not verified.");
  assert.ok(rows.some(row=>row.details?.status==="refused"));
  assert.ok(rows.filter(row=>row.tool==="browser_close" && row.details?.status==="closed").length>=2);
  for (const [index,row] of observed.entries()) {
    const content=getToolExecutionResult(result,row.callId).content;
    const image=content.find(block=>block.type==="image");
    assert.ok(image,"Real PNG not forwarded to model.");
    await writeFile(path.join(directory,index+".png"),Buffer.from(image.data,"base64"));
    row.image=index+".png";
  }
  success=true;
  summary={model:result.state.model,toolNames:getToolCallNames(result),rows,artifacts:result.artifacts};
} finally {
  await fixture.close();
  const cleanup=await browserNativeState();
  assert.equal(cleanup.browserCount,0); assert.equal(cleanup.workerCount,0); assert.equal(cleanup.profiles.length,0);
  await writeFile(path.join(directory,"run.json"),JSON.stringify({success,...summary,cleanup},null,2)+"\n");
}
console.log(JSON.stringify({success,tools:summary.toolNames?.length,directory}));
