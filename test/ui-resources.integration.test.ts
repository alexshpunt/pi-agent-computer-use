import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi Codemode refines full resources locally and dispatches only a current enabled hint", async () => {
  await mkdir(".tmp/ui-resources", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/ui-resources/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/ui-resources-driver.mjs"), log],
  }));
  const code = `const listed = await tools.computer_windows({});
const windows = JSON.parse(listed.slice(listed.indexOf("{"))).state.windows;
store("uiWindow", windows[0].window_ref);
const observe = async extra => {
 const view = await tools.computer_observe({window_ref:load("uiWindow"),...extra});
 store("uiObservation",view.observation_id); return view;
};
const first = await observe({capture:{max_elements:200,max_depth:15,guides:{grid:true,region:true,action:true}}});
if(first.agent_image.annotation.guides.grid.status!=="shown")throw Error("Missing output-pixel grid");
const region = await observe({ui:{operation:"region",observation_id:load("uiObservation"),region:{x:20,y:40,width:200,height:130}}});
if(region.agent_image.annotation.guides.region.status!=="shown"||region.observation_id!==first.observation_id)throw Error("Region replaced the input snapshot");
if (first.ui.elements.length !== 200 || first.ui.complete !== false) throw Error("Lost full resource");
const candidates = await observe({ui:{operation:"search",observation_id:load("uiObservation"),query:"Save",limit:2}});
if (candidates.ui.matches !== 199 || !candidates.ui.projection_truncated) throw Error("False search completeness");
store("uiHint",candidates.ui.elements[0].hint); store("disabledHint",candidates.ui.elements[1].hint);
const inspect = await observe({ui:{operation:"inspect",observation_id:load("uiObservation"),hint:load("uiHint")}});
if (inspect.image || inspect.ui.elements[0].element_token !== candidates.ui.elements[0].element_token) throw Error("Inspection rebound target");
const marked = await observe({ui:{operation:"highlight",observation_id:load("uiObservation"),hint:load("uiHint")}});
if (!marked.image || marked.agent_image.annotation.selected_hint !== load("uiHint")) throw Error("Missing selected image");
const act = async hint => {
 try { const result = await tools.computer_act({window_ref:load("uiWindow"),observation_id:load("uiObservation"),action:"click",hint});
  return JSON.parse(result.slice(result.indexOf("{"))); }
 catch (error) { const result = String(error.message); return JSON.parse(result.slice(result.indexOf("{"))); }
};
if ((await act(load("disabledHint"))).status !== "refused") throw Error("Disabled input admitted");
const other = await tools.computer_observe({window_ref:windows[1].window_ref});
if ((await act(other.ui.elements[1].hint)).status !== "refused") throw Error("Foreign hint admitted");
const latest = await observe({capture:{max_elements:3,hints:false}});
if ((await act(load("uiHint"))).status !== "refused") throw Error("Old alias rebound");
store("uiHint",latest.ui.elements[1].hint);
const delivered = await act(load("uiHint"));
if (delivered.status !== "delivered" || delivered.state.path !== "ax") throw Error("Current hint not dispatched");
if ((await act(load("uiHint"))).status !== "refused") throw Error("Consumed hint replayed");
text("UI resource guards passed: 200 collected, 199 search matches, one native click");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "ui-resources", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_windows", "computer_observe", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "ui", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Refine observed UI resources locally and act only on the exact current enabled target.");
    expect(getToolExecution(result, "ui").isError, getToolResultText(result, "ui")).toBe(false);
    expect(getToolResultText(result, "ui")).toContain("UI resource guards passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "get_window_state")).toHaveLength(3);
    expect(calls.filter(c => c.name === "click").map(c => c.arguments.element_token)).toEqual(["s3:1"]);
    expect(calls.some(c => ["bring_to_front", "scroll", "zoom"].includes(c.name))).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
