import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi Codemode independently branches on true, false, unknown and error", async () => {
  await mkdir(".tmp/classifier-predicate", {recursive:true});
  const cwd = await mkdtemp(path.resolve(".tmp/classifier-predicate/pi-"));
  await sharp({create:{width:8,height:8,channels:3,background:"green"}}).png().toFile(path.join(cwd,"sample.png"));
  const code = `const classify = extra => tools.computer_classify({image:"sample.png",condition:"one condition",threshold:.3,...extra});
const yes = await classify({});
const no = await classify({threshold:.5});
const unknown = await classify({threshold:.4,uncertainty:.02});
let error = false;
try { await classify({condition:"worker error"}); } catch { error = true; }
const branches = [];
for (const result of [yes,no,unknown]) {
 if(result.value === true) branches.push("react");
 else if(result.value === false) branches.push("continue");
 else if(result.value === null) branches.push("inspect");
 else throw Error("Not a typed predicate");
}
if(branches.join(",")!=="react,continue,inspect" || !error || !no.cache_hit || yes.cache_hit) throw Error("Broken classifier contract");
await tools.computer_close({});
const fresh = await classify({});
if(fresh.cache_hit) throw Error("Close kept the fixture worker warm");
text({branches,error,cache_reused:no.cache_hit,fresh_after_close:!fresh.cache_hit});`;
  try {
    const result = await new PiIntegrationTest({
      testName:"visual-classifier",artifactsDir:testArtifactsDir(import.meta.filename),cwd,
      extensions:[path.resolve("test/fixtures/classifier-extension.ts")],isolateUserResources:true,
      tools:["codemode","computer_classify","computer_close"],
      conversation:[assistantMessage([toolCall({id:"predicate",name:"codemode",arguments:{code}})],{stopReason:"toolUse"}),
        assistantMessage([text("Done")])],
    }).run("Check independent visual predicate branching without capture or input.");
    expect(getToolExecution(result,"predicate").isError,getToolResultText(result,"predicate")).toBe(false);
    expect(getToolResultText(result,"predicate")).toContain("inspect");
    const body = getToolResultText(result,"predicate");
    expect(JSON.parse(body.slice(body.indexOf("{")))).toMatchObject({ branches:["react","continue","inspect"],error:true,cache_reused:true,fresh_after_close:true });
  } finally { await rm(cwd,{recursive:true,force:true}); }
});
