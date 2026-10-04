import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi forwards only final display crop and window JPEG, and disarms overview input", async () => {
  await mkdir(".tmp/native-zoom", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/native-zoom/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/detail-driver.mjs"), log],
  }));
  const code = `const opened = await tools.computer_open({app:"Notepad"});
const win = JSON.parse(opened.slice(opened.indexOf("{")));
const rectangle = {x:100,y:80,width:100,height:80};
const detail = await tools.computer_observe({window_ref:win.window_ref,
  zoom:{...rectangle,image_id:win.agent_image.image_id}});
text(detail.source); image(detail.image);
let inputStopped = false;
try { await tools.computer_act({window_ref:win.window_ref,observation_id:win.observation_id,
  action:"click",element_token:"close"}); } catch { inputStopped = true; }
if (!inputStopped) throw Error("Old overview still armed");
const overview = await tools.computer_observe({display:"primary"});
const crop = await tools.computer_observe({display:"primary",zoom:{...rectangle,image_id:overview.agent_image.image_id}});
text(crop.source); image(crop.image);
const nested = await tools.computer_observe({display:"primary",zoom:{...rectangle,image_id:overview.agent_image.image_id}});
if (nested.status !== "refused" || nested.image) throw Error("Consumed overview reused");
text("Read-only detail guards passed");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "native-detail", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_open", "computer_observe", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "detail", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Read details only. Never dispatch input from the old overview or publish intermediate full-display pixels.");
    expect(getToolExecution(result, "detail").isError).toBe(false);
    const answer = getToolExecutionResult(result, "detail") as { content: { type: string; mimeType?: string }[] };
    expect(answer.content.filter(b => b.type === "image").map(b => b.mimeType)).toEqual(["image/jpeg", "image/png"]);
    expect(getToolResultText(result, "detail")).toContain("Read-only detail guards passed");
    expect(getToolResultText(result, "detail")).not.toContain("PRIVATE_NATIVE_DISPLAY");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "zoom")).toHaveLength(1);
    expect(calls.filter(c => c.name === "get_desktop_state").map(c => c.arguments)).toEqual([{max_image_dimension:500},{max_image_dimension:0}]);
    expect(calls.some(c => ["click", "bring_to_front"].includes(c.name))).toBe(false);
  } finally { await rm(cwd, {recursive:true,force:true}); }
});
