import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi returns only requested window parts and admits only their current input", async () => {
  await mkdir(".tmp/observe-granularity", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/observe-granularity/pi-contract-"));
  const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/observation-granularity-driver.mjs"), log],
  }));
  // Any refused input spends its observation, so each refusal check uses a fresh overview of the requested part.
  const code = `${SCRIPT_HELPERS}
const win = address(await windows(), "window");
const read = views => tools.computer_read({path:win,...(views?{views}:{})});
// Only the reads are under test here: clicks skip the default successor, so every native capture is a read.
const click = async (view,target) => (await insert(observation(view),{action:"click",...target,successor:false})).outcome;
const full=await read();
if(typeof full==="string"||!hints(full).length)throw Error("Full default changed");
const fullHint=hints(full)[0];
let image=await read(["image"]);
if(typeof image==="string"||hints(image).length||/^UI:/m.test(image.note))throw Error("Image inherited UI");
if(await click(image,{hint:fullHint})!=="refused")throw Error("Retired hint admitted");
image=await read(["image"]);
// The peer keeps its first snapshot's native token; an image-only overview must not admit it.
if(await click(image,{element_token:"s1:0"})!=="refused")throw Error("Retained native token admitted");
image=await read(["image"]);
if(await click(image,{x:75,y:60})!=="delivered")throw Error("Image pixel input missing");
if(await click(image,{x:75,y:60})!=="refused")throw Error("Consumed image replayed");
let ui=await read(["ui"]);
if(typeof ui!=="string"||!/image_bounds=null/.test(ui))throw Error("UI inherited pixels");
if(await click(ui,{x:75,y:60})!=="refused")throw Error("UI pixel input admitted");
ui=await read(["ui"]);
const inspected=await tools.computer_read({path:observation(ui),views:["element:inspect,"+hints(ui)[0]]});
if(typeof inspected!=="string"||!/\\| Button \\| Save \\|/.test(inspected))throw Error("UI inspection changed");
if(await click(ui,{hint:hints(ui)[0]})!=="delivered")throw Error("UI hint missing");
text("Three mode contracts passed; exactly two native clicks.");
`;
  try {
    const result = await new PiIntegrationTest({
      testName: "observation-granularity", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [
        assistantMessage([toolCall({ id: "parts", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use three observation granularities without inheriting omitted authority.");
    expect(getToolExecution(result, "parts").isError, getToolResultText(result, "parts")).toBe(false);
    expect(getToolResultText(result, "parts")).toContain("Three mode contracts passed");
    const reads = nestedCalls(getToolExecutions(result), "parts").filter(call => call.name === "computer_read" && call.computer.granularity);
    expect(reads.map(call => call.computer.granularity)).toEqual(["full", "image", "image", "image", "ui", "ui"]);
    for (const call of reads.filter(call => call.computer.granularity === "image")) {
      expect(call.computer.source.semantic_scope).toBe("none");
      expect(call.computer.ui).toBeUndefined();
    }
    for (const call of reads.filter(call => call.computer.granularity === "ui")) expect(call.computer.agent_image).toBeUndefined();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const native = calls.filter(c => c.name === "get_window_state");
    expect(native).toHaveLength(6);
    for (const index of [1, 2, 3]) expect(native[index].arguments.include_accessibility_tree).toBe(false);
    for (const index of [4, 5]) expect(native[index].arguments.include_screenshot).toBe(false);
    expect(calls.filter(c => c.name === "click").map(c => c.arguments.element_token ?? [c.arguments.x,c.arguments.y]))
      .toEqual([[75,60],"s6:0"]);
    expect(calls.some(c => c.name === "zoom" || c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
