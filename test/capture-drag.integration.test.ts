import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// This checks the real Pi/MCP boundary, not native Windows application behavior.
test("real Pi keeps drag capture binding and stops on resize refusal until reobserved", async () => {
  await mkdir(".tmp/lpt-619", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-619/pi-capture-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log, "capture-drag"] }));
  const code = `const opened = await tools.computer_open({app:"Notepad"});
const first = JSON.parse(opened.slice(opened.indexOf("{")));
store("window",first.window_ref); store("observation",first.observation_id);
const act = async sequence => {
 try { const result = await tools.computer_act({window_ref:load("window"),observation_id:load("observation"),action:"sequence",sequence});
  return JSON.parse(result.slice(result.indexOf("{")));
 } catch(error) { const result=String(error.message); return JSON.parse(result.slice(result.indexOf("{"))); }
};
const drag={action:"drag",from_x:30,from_y:40,to_x:100,to_y:80,duration_ms:100,steps:4};
const stopped=await act([{action:"key",key:"r"},drag,{action:"key",key:"b"}]);
if(stopped.status!=="refused" || stopped.state.code!=="capture_frame_mismatch" || stopped.state.sequence.completed!==1 ||
 stopped.state.sequence.attempted!==2) throw Error("Resize refusal or completed prefix lost");
text(stopped.state.sequence);
if((await act([drag])).status!=="refused") throw Error("Consumed overview replayed");
const view=await tools.computer_observe({window_ref:load("window")}); store("observation",view.observation_id);
if(JSON.stringify(view.source_identity)!==JSON.stringify(first.source_identity)) throw Error("Resize changed source identity");
const fresh=await act([drag]);
if(fresh.status!=="delivered" || fresh.state.sequence.completed!==1) throw Error("Fresh capture drag refused");
if((await act([drag])).status!=="refused") throw Error("Fresh overview remained armed");
text("Capture-bound drag refusal and fresh recovery passed");`;
  try {
    const result = await new PiIntegrationTest({ testName: "capture-bound-drag", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/capture-drag-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_open", "computer_observe", "computer_act", "computer_close"],
      conversation: [assistantMessage([toolCall({ id: "drag", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")])],
    }).run("Use the synthetic MCP capture fixture; stop after resize refusal and observe before trying fresh input.");
    expect(getToolExecution(result, "drag").isError, getToolResultText(result, "drag")).toBe(false);
    expect(getToolResultText(result, "drag")).toContain("Capture-bound drag refusal and fresh recovery passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const input = calls.filter(c => ["press_key", "drag"].includes(c.name));
    expect(input.map(c => c.name)).toEqual(["press_key", "drag", "drag"]);
    expect(input[0].arguments.key).toBe("r");
    expect(input.slice(1).map(c => c.arguments)).toEqual(["capture-1", "capture-2"].map(capture_id => ({
      target: { kind: "window", pid: 42, window_id: 91 }, delivery_mode: "background", capture_id,
      from_x: 30, from_y: 40, to_x: 100, to_y: 80, duration_ms: 100, steps: 4,
    })));
    expect(calls.filter(c => c.name === "get_window_state")).toHaveLength(2);
    expect(calls.some(c => c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
