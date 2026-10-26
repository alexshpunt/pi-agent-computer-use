import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi returns only requested window parts and grounds input in the latest Read", async () => {
  await mkdir(".tmp/observe-granularity", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/observe-granularity/pi-contract-"));
  const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/observation-granularity-driver.mjs"), log],
  }));
  const code = `${SCRIPT_HELPERS}
const win = address(await windows(), "window");
const read = views => tools.computer_read({path:win,...(views?{views}:{})});
const click = async target => (await tools.computer_click({window:win,...target})).outcome;
const full=await read();
if(typeof full==="string"||!hints(full).length)throw Error("Full default changed");
const fullHint=hints(full)[0];
const image=await read(["image"]);
if(typeof image==="string"||hints(image).length||/^UI:/m.test(image.note))throw Error("Image inherited UI");
if(await click({target:fullHint})!=="refused")throw Error("A ref of an earlier Read admitted");
if(await click({x:75,y:60})!=="delivered")throw Error("Image pixel input missing");
let ui=await read(["ui"]);
if(typeof ui!=="string"||!/image_bounds=null/.test(ui))throw Error("UI inherited pixels");
// A point needs the window's pixels: after a UI-only Read the click captures the window first.
if(await click({x:75,y:60})!=="delivered")throw Error("Point after a UI Read refused");
ui=await read(["ui"]);
const inspected=await tools.computer_read({path:observation(ui),views:["element:inspect,"+hints(ui)[0]]});
if(typeof inspected!=="string"||!/\\| Button \\| Save \\|/.test(inspected))throw Error("UI inspection changed");
if(await click({target:hints(ui)[0]})!=="delivered")throw Error("UI ref missing");
text("Three mode contracts passed; exactly three native clicks.");
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
    expect(reads.map(call => call.computer.granularity)).toEqual(["full", "image", "ui", "ui"]);
    for (const call of reads.filter(call => call.computer.granularity === "image")) {
      expect(call.computer.source.semantic_scope).toBe("none");
      expect(call.computer.ui).toBeUndefined();
    }
    for (const call of reads.filter(call => call.computer.granularity === "ui")) expect(call.computer.agent_image).toBeUndefined();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const clicks = calls.flatMap((c, index) => c.name === "click" ? [index] : []);
    expect(clicks.map(index => calls[index].arguments.element_token ?? [calls[index].arguments.x, calls[index].arguments.y]))
      .toEqual([[75, 60], [75, 60], expect.stringMatching(/^s\d+:0$/)]);
    // The second point click captured pixels after the UI-only Read before it clicked.
    const before = calls.slice(0, clicks[1]).filter(c => c.name === "get_window_state").at(-1);
    expect(before.arguments.include_screenshot).not.toBe(false);
    expect(calls.some(c => c.name === "zoom" || c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
