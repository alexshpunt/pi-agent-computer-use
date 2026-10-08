import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi exposes the capture failure without pixels, old input or hidden recovery", async () => {
  await mkdir(".tmp/window-capture-failure", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/window-capture-failure/pi-contract-"));
  const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/window-capture-failure-driver.mjs"), log],
  }));
  const code = `const parse = r => JSON.parse(r.slice(r.indexOf("{")));
const row=parse(await tools.computer_windows({})).state.windows[0];
store("failureWindow",row.window_ref);
const before=await tools.computer_observe({window_ref:load("failureWindow")});
if(before.status!=="observed"||!before.image)throw Error("Missing first image");
const failed=await tools.computer_observe({window_ref:load("failureWindow")});
if(failed.status!=="refused"||!failed.state.screenshot_error.includes("minimized"))throw Error("Native cause lost");
if(failed.image||failed.agent_image||failed.observation_id||failed.ui)throw Error("Failure granted authority");
let replay;try{replay=parse(await tools.computer_act({window_ref:load("failureWindow"),observation_id:before.observation_id,action:"click",x:20,y:20}));}
catch(error){replay=parse(error.message);}
if(replay.status!=="refused")throw Error("Failed capture retained old input");
const ui=await tools.computer_observe({window_ref:load("failureWindow"),capture:{granularity:"ui"}});
if(ui.status!=="observed"||ui.image||ui.state.screenshot_error)throw Error("UI-only inherited failed pixels");
text("Minimized screenshot refused with native cause; old input refused; UI-only stays independent.");
`;
  try {
    const result = await new PiIntegrationTest({
      testName: "window-capture-failure", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_windows", "computer_observe", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "capture", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Observe the capture failure without activating or restoring any window.");
    expect(getToolExecution(result, "capture").isError, getToolResultText(result, "capture")).toBe(false);
    expect(getToolResultText(result, "capture")).toContain("Minimized screenshot refused with native cause");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "get_window_state")).toHaveLength(3);
    expect(calls.every(c => ["fixture_identity", "list_windows", "get_window_state"].includes(c.name))).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
