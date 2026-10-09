import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi selects WGC by default on its selected runtime and keeps explicit native capture", async () => {
  await mkdir(".tmp/wgc-integration", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/wgc-integration/pi-contract-"));
  const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/observation-granularity-driver.mjs"), log],
  }));
  const code = `const parse = result => JSON.parse(result.slice(result.indexOf("{")));
const windows = parse(await tools.computer_windows({})).state.windows;
store("wgcWindow",windows[0].window_ref);
const observe = (capture,query) => tools.computer_observe({window_ref:load("wgcWindow"),capture,...(query?{query}:{})});
const act = async id => {
 try {return parse(await tools.computer_act({window_ref:load("wgcWindow"),observation_id:id,action:"click",x:75,y:60}));}
 catch(error){return parse(String(error.message));}
};
const full=await observe({backend:"default"});
if(full.status!=="observed"||!full.ui||!full.image)throw Error("Default changed");
const image=await observe({granularity:"image"});
if(image.status!=="observed"||!image.image||image.ui||image.state.capture_backend.backend!=="wgc")throw Error("WGC parts missing");
if((await act(image.observation_id)).status!=="delivered")throw Error("WGC input missing");
if((await act(image.observation_id)).status!=="refused")throw Error("WGC input replayed");
const wgcFull=await observe({granularity:"full",hints:false});
if(wgcFull.status!=="observed"||!wgcFull.ui||!wgcFull.image)throw Error("Full WGC missing");
const ui=await observe({granularity:"ui"});
if(ui.status!=="observed"||ui.image||ui.state.capture_backend||ui.state.capture_id)throw Error("UI inherited WGC pixels");
let bad;
try {bad=await observe({granularity:"ui",backend:"wgc"});} catch(error){bad=parse(String(error.message));}
if(bad.status!=="refused")throw Error("UI-only started WGC");
let substituted;
try {substituted=await observe({granularity:"full",backend:"wgc"},"substitute");} catch(error){substituted=parse(String(error.message));}
if(substituted.status!=="refused"||substituted.image||substituted.observation_id)throw Error("Substitute acquired authority");
if((await act(wgcFull.observation_id)).status!=="refused")throw Error("Old capture admitted");
text("WGC projection passed; exactly one native click and no fallback.");
`;
  try {
    const result = await new PiIntegrationTest({
      testName: "persistent-wgc", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/persistent-wgc-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_windows", "computer_observe", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "wgc", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use selected-runtime WGC by default without inheriting pixel authority; explicit default keeps native capture.");
    expect(getToolExecution(result, "wgc").isError, getToolResultText(result, "wgc")).toBe(false);
    expect(getToolResultText(result, "wgc")).toContain("WGC projection passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const reads = calls.filter(c => c.name === "get_window_state");
    expect(reads.map(c => c.arguments.capture_backend ?? "default")).toEqual(["default","wgc","wgc","default","wgc"]);
    expect(reads[1].arguments.include_accessibility_tree).toBe(false);
    expect(reads[3].arguments.include_screenshot).toBe(false);
    expect(calls.filter(c => c.name === "click").map(c => [c.arguments.x,c.arguments.y])).toEqual([[75,60]]);
    expect(calls.some(c => c.name === "zoom" || c.name === "get_desktop_state" || c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
