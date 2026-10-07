import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi returns only requested window parts and admits only their current input", async () => {
  await mkdir(".tmp/observe-granularity", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/observe-granularity/pi-contract-"));
  const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/observation-granularity-driver.mjs"), log],
  }));
  const code = `const parse = result => JSON.parse(result.slice(result.indexOf("{")));
const windows = parse(await tools.computer_windows({})).state.windows;
store("partsWindow",windows[0].window_ref);
const observe = capture => tools.computer_observe({window_ref:load("partsWindow"),...(capture?{capture}:{})});
const act = async (view,target) => {
 try {return parse(await tools.computer_act({window_ref:load("partsWindow"),observation_id:view.observation_id,action:"click",...target}));}
 catch(error){return parse(String(error.message));}
};
const full=await observe();
if(full.granularity!=="full"||!full.image||!full.ui)throw Error("Full default changed");
const image=await observe({granularity:"image"});
if(!image.image||image.ui||image.state.elements||image.source.semantic_scope!=="none")throw Error("Image inherited UI");
if((await act(image,{hint:full.ui.elements[0].hint})).status!=="refused")throw Error("Retired hint admitted");
if((await act(image,{element_token:full.ui.elements[0].element_token})).status!=="refused")throw Error("Retained native token admitted");
if((await act(image,{x:75,y:60})).status!=="delivered")throw Error("Image pixel input missing");
if((await act(image,{x:75,y:60})).status!=="refused")throw Error("Consumed image replayed");
const ui=await observe({granularity:"ui"});
if(ui.image||ui.agent_image||ui.state.capture_id||ui.state.elements[0].screenshot_frame||ui.ui.elements[0].bounds.window_image)throw Error("UI inherited pixels");
if((await act(ui,{x:75,y:60})).status!=="refused")throw Error("UI pixel input admitted");
const inspected=await tools.computer_observe({window_ref:load("partsWindow"),ui:{operation:"inspect",observation_id:ui.observation_id,hint:ui.ui.elements[0].hint}});
if(inspected.image||inspected.ui.elements[0].name!=="Save")throw Error("UI inspection changed");
if((await act(ui,{hint:ui.ui.elements[0].hint})).status!=="delivered")throw Error("UI hint missing");
text("Three mode contracts passed; exactly two native clicks.");
`;
  try {
    const result = await new PiIntegrationTest({
      testName: "observation-granularity", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_windows", "computer_observe", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "parts", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use three observation granularities without inheriting omitted authority.");
    expect(getToolExecution(result, "parts").isError, getToolResultText(result, "parts")).toBe(false);
    expect(getToolResultText(result, "parts")).toContain("Three mode contracts passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const reads = calls.filter(c => c.name === "get_window_state");
    expect(reads).toHaveLength(3);
    expect(reads[1].arguments.include_accessibility_tree).toBe(false);
    expect(reads[2].arguments.include_screenshot).toBe(false);
    expect(calls.filter(c => c.name === "click").map(c => c.arguments.element_token ?? [c.arguments.x,c.arguments.y]))
      .toEqual([[75,60],"s3:0"]);
    expect(calls.some(c => c.name === "zoom" || c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
