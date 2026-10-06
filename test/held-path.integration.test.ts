import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi Codemode rejects an invalid path batch and preserves a partial stroke without replay", async () => {
  await mkdir(".tmp/cua-drag-fork", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/cua-drag-fork/pi-path-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log],
  }));
  const code = `const raw = await tools.computer_open({app:"Notepad"});
const opened = JSON.parse(raw.slice(raw.indexOf("{")));
store("path_window",opened.window_ref); store("path_observation",opened.observation_id);
const send = async sequence => {
 try {
  const raw = await tools.computer_act({window_ref:load("path_window"),observation_id:load("path_observation"),action:"sequence",delivery_mode:"foreground",sequence});
  return JSON.parse(raw.slice(raw.indexOf("{")));
 } catch(error) { const raw = error.message; return JSON.parse(raw.slice(raw.indexOf("{"))); }
};
const invalid = await send([{action:"key",key:"a"},{action:"drag",from_x:20,from_y:30,via:[{x:501,y:40}],to_x:100,to_y:30}]);
if(invalid.status !== "refused") throw Error("Invalid tail admitted");
const stopped = await send([{action:"drag",from_x:20,from_y:30,via:[{x:40,y:80},{x:90,y:70}],to_x:100,to_y:30,duration_ms:800},{action:"key",key:"a"}]);
if(stopped.status !== "unknown" || stopped.state.delivery.delivered_count !== 2 || stopped.state.sequence.attempted !== 1 || stopped.state.sequence.completed !== 0) throw Error("Lost partial path");
text(stopped.state);
if((await send([{action:"key",key:"a"}])).status !== "refused") throw Error("Replay admitted");
store("path_observation",null); text("Held path guards passed");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "held-path", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/held-path-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_open", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "path", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Draw only a bounded known-target path. Never replay partial input.");
    expect(getToolExecution(result, "path").isError, getToolResultText(result, "path")).toBe(false);
    expect(getToolResultText(result, "path")).toContain("Held path guards passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const inputs = calls.filter(call => ["press_key","drag","fixture_held_path"].includes(call.name));
    expect(inputs).toEqual([{ name: "fixture_held_path", arguments: {
      pid: 42, window_id: 91, delivery_mode: "foreground", from_x: 20, from_y: 30,
      via: [{ x: 40, y: 80 }, { x: 90, y: 70 }], to_x: 100, to_y: 30, duration_ms: 800,
    } }]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
