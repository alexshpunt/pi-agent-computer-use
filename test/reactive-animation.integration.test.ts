import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi scopes configured animation to explicit input and restores normal input across close", async () => {
  await mkdir(".tmp/reactive-animation", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/reactive-animation/pi-"));
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/reactive-animation.json"), JSON.stringify({ glide_duration_ms: 2 }));
  const code = `${SCRIPT_HELPERS}
let win, view, counter;
const discover = async () => { win = address(await windows(), "window"); };
const observe = async () => {
 const read = await tools.computer_read({path:win});
 view = observation(read);
 counter = body(read).split("\\n").find(line => line.includes("| Counter |")).split(" | ")[0];
};
const send = extra => insert(view, {action:"click",hint:counter,...extra});
await discover(); await observe();
const reactive = await send({animation:"reactive"});
if(reactive.outcome !== "delivered") throw Error("Reactive scope lost");
if((await send({animation:"reactive"})).outcome !== "refused") throw Error("Consumed observation reused");
await observe();
const ordinary = await send({});
if(ordinary.outcome !== "delivered") throw Error("Ordinary scope changed");
await insert("computer:session",{action:"close"}); await discover(); await observe();
const fresh = await send({});
if(fresh.outcome !== "delivered") throw Error("Close blocked fresh ordinary action");
text("reactive, ordinary, consumed_refused, fresh_after_close");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "reactive-animation", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/reactive-animation-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_insert"],
      conversation: [
        assistantMessage([toolCall({ id: "animation", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_insert", arguments: { path: "computer:session", text: '{"action":"close"}' } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use explicit animation only for reactive input. Do not replay a consumed observation.");
    expect(getToolExecution(result, "animation").isError, getToolResultText(result, "animation")).toBe(false);
    expect(getToolResultText(result, "animation")).toContain("fresh_after_close");
    const clicks = nestedCalls(getToolExecutions(result), "animation").filter(call => call.computer.status === "delivered" && call.computer.state?.count !== undefined);
    expect(clicks).toHaveLength(3);
    expect(clicks[0].computer.state.animation).toMatchObject({ glide_duration_ms: 2, restored: true });
    expect(clicks.slice(1).map(call => call.computer.state.animation)).toEqual([undefined, undefined]);
    const calls = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.name === "click").map(call => call.glide)).toEqual([2, 240, 240]);
    expect(calls.filter(call => call.name === "set_agent_cursor_motion").map(call => call.args.glide_duration_ms)).toEqual([2, 240]);
    expect(calls.filter(call => call.name === "click").every(call => call.args.animation === undefined)).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
