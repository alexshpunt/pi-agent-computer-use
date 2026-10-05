import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi Codemode validates a whole sequence, forwards complete steps and stops without replay", async () => {
  await mkdir(".tmp/cua-gestures", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/cua-gestures/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log],
  }));
  const code = `const opened = await tools.computer_open({app:"Notepad"});
const first = JSON.parse(opened.slice(opened.indexOf("{")));
store("window", first.window_ref); store("observation", first.observation_id);
const act = async sequence => {
 try {
  const result = await tools.computer_act({window_ref:load("window"),observation_id:load("observation"),action:"sequence",sequence});
  return JSON.parse(result.slice(result.indexOf("{")));
 } catch (error) {
  const result = String(error.message); return JSON.parse(result.slice(result.indexOf("{")));
 }
};
const invalid = await act([{action:"key",key:"a"},{action:"key",key:"a",duration_ms:100}]);
if (invalid.status !== "refused") throw Error("Invalid tail admitted");
const success = await act([{action:"key",key:"a"},{action:"hotkey",keys:["shift","b"],wait_ms:10},
 {action:"drag",from_x:30,from_y:40,to_x:100,to_y:80,duration_ms:100,steps:4}]);
if (success.state.sequence.completed !== 3) throw Error("Missing completed sequence");
text(success.state.sequence);
const retired = await act([{action:"key",key:"c"}]);
if (retired.status !== "refused") throw Error("Overview still armed");
for (const key of ["escape","delete"]) {
 const view = await tools.computer_observe({window_ref:load("window")}); store("observation",view.observation_id);
 const stopped = await act([{action:"key",key:"a"},{action:"key",key},{action:"key",key:"c"}]);
 if (stopped.state.sequence.completed !== 1 || stopped.state.sequence.attempted !== 2 || stopped.status !== (key === "escape" ? "unknown" : "refused")) throw Error("False completed prefix");
 text(stopped.state.sequence);
 const stale = await act([{action:"key",key:"c"}]);
 if (stale.status !== "refused") throw Error("Stopped sequence could replay");
}
store("observation",null); text("Complete sequence guards passed");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "complete-input", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_open", "computer_observe", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "sequence", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use complete known-target sequences. Never replay a completed prefix or uncertain input.");
    expect(getToolExecution(result, "sequence").isError, getToolResultText(result, "sequence")).toBe(false);
    expect(getToolResultText(result, "sequence")).toContain("Complete sequence guards passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const input = calls.filter(c => ["press_key", "hotkey", "drag"].includes(c.name));
    expect(input.map(c => c.name)).toEqual(["press_key", "hotkey", "drag", "press_key", "press_key", "press_key", "press_key"]);
    expect(input.map(c => c.arguments.target)).toEqual(Array(7).fill({ kind: "window", pid: 42, window_id: 91 }));
    expect(input.every(c => c.arguments.delivery_mode === "background")).toBe(true);
    expect(calls.filter(c => c.name === "get_window_state")).toHaveLength(3);
    expect(calls.some(c => c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
