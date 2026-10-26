import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi Codemode validates a whole sequence, forwards complete steps and stops without replay", async () => {
  await mkdir(".tmp/cua-gestures", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/cua-gestures/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log],
  }));
  // Any refused input spends its observation, so the valid sequence acts on a fresh overview.
  const code = `${SCRIPT_HELPERS}
const opened = await openApp("Notepad");
if (opened.outcome !== "observed" || !opened.window || !opened.observation) throw Error("Open returned no window and observation");
if (!(await windows()).includes(opened.window)) throw Error("Discovery lost the opened window");
// These checks keep one observation for pixel input, so they turn the default successor off.
const act = async (view, sequence) => insert(view, {action:"sequence",sequence,successor:false});
const invalid = await act(opened.observation, [{action:"key",key:"a"},{action:"key",key:"a",duration_ms:100}]);
if (invalid.outcome !== "refused" || invalid.effect !== "not-applied") throw Error("Invalid tail admitted");
const current = observation(await tools.computer_read({path:opened.window}));
const success = await act(current, [{action:"key",key:"a"},{action:"hotkey",keys:["shift","b"],wait_ms:10},
 {action:"drag",from_x:30,from_y:40,to_x:100,to_y:80,duration_ms:100,steps:4}]);
if (success.outcome !== "delivered" || success.steps?.length !== 3) throw Error("Missing completed sequence");
text(JSON.stringify(success.steps));
const retired = await act(current, [{action:"key",key:"c"}]);
if (retired.outcome !== "refused") throw Error("Overview still armed");
for (const key of ["escape","delete"]) {
 const view = observation(await tools.computer_read({path:opened.window}));
 const stopped = await act(view, [{action:"key",key:"a"},{action:"key",key},{action:"key",key:"c"}]);
 if (stopped.outcome !== (key === "escape" ? "unknown" : "refused") || stopped.effect !== "unknown" || stopped.steps?.length !== 2) throw Error("False completed prefix");
 text(JSON.stringify(stopped.steps));
 const stale = await act(view, [{action:"key",key:"c"}]);
 if (stale.outcome !== "refused") throw Error("Stopped sequence could replay");
}
text("Complete sequence guards passed");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "complete-input", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [
        assistantMessage([toolCall({ id: "sequence", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use complete known-target sequences. Never replay a completed prefix or uncertain input.");
    expect(getToolExecution(result, "sequence").isError, getToolResultText(result, "sequence")).toBe(false);
    expect(getToolResultText(result, "sequence")).toContain("Complete sequence guards passed");
    const nested = nestedCalls(getToolExecutions(result), "sequence");
    const [opened, discovery] = nested;
    expect(discovery.computer.state.windows[0].source_identity).toEqual(opened.computer.source_identity);
    expect(opened.computer.source.identity.session_id).toBe(opened.computer.source_identity.identity.session_id);
    expect(opened.computer.source.membership).toMatchObject({ monitor_id: null, virtual_desktop_id: null });
    const sequences = nested.filter(call => call.name === "computer_insert" && call.computer.state?.sequence).map(call => call.computer);
    expect(sequences.map(item => [item.status, item.state.sequence.completed, item.state.sequence.attempted])).toEqual([
      ["delivered", 3, 3], ["unknown", 1, 2], ["refused", 1, 2]]);
    expect(sequences[0].state.sequence.steps.every((step: { action_capability: { background: string; scope: string } }) =>
      step.action_capability.background === "delivered" && step.action_capability.scope === "attempted_action_only")).toBe(true);
    expect(sequences[1].state.sequence.steps[1].action_capability.background).toBe("unknown");
    expect(sequences[2].state.sequence.steps[1].action_capability).toMatchObject({ background: "unavailable", foreground: "suggested" });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const input = calls.filter(c => ["press_key", "hotkey", "drag"].includes(c.name));
    expect(input.map(c => c.name)).toEqual(["press_key", "hotkey", "drag", "press_key", "press_key", "press_key", "press_key"]);
    expect(input.map(c => c.arguments.target)).toEqual(Array(7).fill({ kind: "window", pid: 42, window_id: 91 }));
    expect(input.every(c => c.arguments.delivery_mode === "background")).toBe(true);
    expect(calls.filter(c => c.name === "get_window_state")).toHaveLength(4);
    expect(calls.some(c => c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
