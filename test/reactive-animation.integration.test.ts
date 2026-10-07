import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi scopes configured animation to explicit input and restores normal input across close", async () => {
  await mkdir(".tmp/reactive-animation", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/reactive-animation/pi-"));
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/reactive-animation.json"), JSON.stringify({ glide_duration_ms: 2 }));
  const code = `const parse = raw => JSON.parse(raw.slice(raw.indexOf("{")));
const discover = async () => {
 const windows = parse(await tools.computer_windows({}));
 store("animation_window", windows.state.windows[0].window_ref);
};
const observe = async () => {
 const view = await tools.computer_observe({window_ref:load("animation_window")});
 store("animation_observation",view.observation_id);
 store("animation_hint",view.ui.elements.find(e => e.name === "Counter").hint);
};
const send = async extra => {
 try { return parse(await tools.computer_act({window_ref:load("animation_window"),observation_id:load("animation_observation"),action:"click",hint:load("animation_hint"),...extra})); }
 catch(error) { return parse(error.message); }
};
await discover(); await observe();
const reactive = await send({animation:"reactive"});
if(reactive.status !== "delivered" || reactive.state.animation.glide_duration_ms !== 2 || reactive.state.animation.restored !== true) throw Error("Reactive scope lost");
if((await send({animation:"reactive"})).status !== "refused") throw Error("Consumed observation reused");
await observe();
const ordinary = await send({});
if(ordinary.status !== "delivered" || ordinary.state.animation !== undefined) throw Error("Ordinary scope changed");
await tools.computer_close({}); await discover(); await observe();
const fresh = await send({});
if(fresh.status !== "delivered") throw Error("Close blocked fresh ordinary action");
text({reactive:reactive.state.animation,ordinary:true,consumed_refused:true,fresh_after_close:true});`;
  try {
    const result = await new PiIntegrationTest({
      testName: "reactive-animation", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/reactive-animation-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_windows", "computer_observe", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "animation", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use explicit animation only for reactive input. Do not replay a consumed observation.");
    expect(getToolExecution(result, "animation").isError, getToolResultText(result, "animation")).toBe(false);
    expect(getToolResultText(result, "animation")).toContain("fresh_after_close");
    const calls = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.name === "click").map(call => call.glide)).toEqual([2, 240, 240]);
    expect(calls.filter(call => call.name === "set_agent_cursor_motion").map(call => call.args.glide_duration_ms)).toEqual([2, 240]);
    expect(calls.filter(call => call.name === "click").every(call => call.args.animation === undefined)).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
