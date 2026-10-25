import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

// This checks the real Pi/MCP boundary, not native Windows application behavior.
test("real Pi keeps drag capture binding and stops on resize refusal until reobserved", async () => {
  await mkdir(".tmp/lpt-619", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-619/pi-capture-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log, "capture-drag"] }));
  const code = `${SCRIPT_HELPERS}
const opened = await openApp("Notepad");
// These checks keep one observation for pixel input, so they turn the default successor off.
const act = (view, sequence) => insert(view, {action:"sequence",sequence,successor:false});
const drag={action:"drag",from_x:30,from_y:40,to_x:100,to_y:80,duration_ms:100,steps:4};
const stopped=await act(opened.observation,[{action:"key",key:"r"},drag,{action:"key",key:"b"}]);
if(stopped.outcome!=="refused" || stopped.code!=="capture_frame_mismatch" || stopped.effect!=="unknown") throw Error("Resize refusal or completed prefix lost");
text(JSON.stringify(stopped.steps));
if((await act(opened.observation,[drag])).outcome!=="refused") throw Error("Consumed overview replayed");
const view=observation(await tools.computer_read({path:opened.window}));
const fresh=await act(view,[drag]);
if(fresh.outcome!=="delivered" || fresh.steps?.length!==1) throw Error("Fresh capture drag refused");
if((await act(view,[drag])).outcome!=="refused") throw Error("Fresh overview remained armed");
text("Capture-bound drag refusal and fresh recovery passed");`;
  try {
    const result = await new PiIntegrationTest({ testName: "capture-bound-drag", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/capture-drag-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_insert"],
      conversation: [assistantMessage([toolCall({ id: "drag", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_insert", arguments: { path: "computer:session", text: '{"action":"close"}' } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")])],
    }).run("Use the synthetic MCP capture fixture; stop after resize refusal and observe before trying fresh input.");
    expect(getToolExecution(result, "drag").isError, getToolResultText(result, "drag")).toBe(false);
    expect(getToolResultText(result, "drag")).toContain("Capture-bound drag refusal and fresh recovery passed");
    const nested = nestedCalls(getToolExecutions(result), "drag");
    const opened = nested[0].computer, reread = nested.find(call => call.name === "computer_read")!.computer;
    expect(reread.source_identity).toEqual(opened.source_identity);
    const sequences = nested.filter(call => call.computer.state?.sequence).map(call => call.computer);
    expect(sequences.map(item => [item.status, item.state.sequence.completed, item.state.sequence.attempted])).toEqual([["refused", 1, 2], ["delivered", 1, 1]]);
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
