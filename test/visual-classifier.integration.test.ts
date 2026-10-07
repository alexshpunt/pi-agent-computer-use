import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi Codemode independently branches on true, false, unknown and error", async () => {
  await mkdir(".tmp/classifier-predicate", {recursive:true});
  const cwd = await mkdtemp(path.resolve(".tmp/classifier-predicate/pi-"));
  const red = await sharp({create:{width:2,height:2,channels:3,background:"red"}}).png().toBuffer();
  await sharp({create:{width:8,height:8,channels:3,background:"green"}})
    .composite([{input:red,left:5,top:3}]).png().toFile(path.join(cwd,"sample.png"));
  const code = `const classify = extra => tools.computer_classify({image:"sample.png",condition:"one condition",threshold:.3,...extra});
const yes = await classify({});
const no = await classify({threshold:.5});
const unknown = await classify({threshold:.4,uncertainty:.02});
let error = false;
try { await classify({condition:"worker error"}); } catch { error = true; }
const region = {x:5,y:3,width:2,height:2};
const cropped = await classify({condition:"red pixel",threshold:.5,region});
const whole = await classify({condition:"red pixel",threshold:.5});
let rejectedRegion = false;
try { await classify({region:{x:7,y:7,width:2,height:2}}); } catch { rejectedRegion = true; }
if(cropped.value!==true || whole.value!==false || !rejectedRegion || JSON.stringify(cropped.region)!==JSON.stringify(region)) throw Error("Broken region transfer");
const regions = [region,{x:0,y:0,width:2,height:2}];
const batch = await classify({condition:"red pixel",threshold:.5,regions});
if(batch.results.length!==2 || batch.results[0].value!==true || batch.results[1].value!==false ||
 JSON.stringify(batch.results.map(r=>r.region))!==JSON.stringify(regions)) throw Error("Broken batch transfer");
let rejectedBoth = false;
try { await classify({region,regions}); } catch { rejectedBoth = true; }
if(!rejectedBoth) throw Error("Conflicting regions were accepted");
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
