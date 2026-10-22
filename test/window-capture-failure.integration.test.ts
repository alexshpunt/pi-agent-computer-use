import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi exposes the capture failure without pixels, old input or hidden recovery", async () => {
  await mkdir(".tmp/window-capture-failure", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/window-capture-failure/pi-contract-"));
  const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/window-capture-failure-driver.mjs"), log],
  }));
  const code = `${SCRIPT_HELPERS}
const win = address(await windows(), "window");
const before=await tools.computer_read({path:win});
if(typeof before==="string")throw Error("Missing first image");
let failure="admitted";
try{await tools.computer_read({path:win});}catch(error){failure=String(error.message);}
if(failure==="admitted")throw Error("Failed capture returned a result");
const replay=await insert(observation(before),{action:"click",x:20,y:20});
if(replay.outcome!=="refused")throw Error("Failed capture retained old input");
const ui=await tools.computer_read({path:win,views:["ui"]});
if(typeof ui!=="string"||!/^Observation: /m.test(ui))throw Error("UI-only inherited failed pixels");
text("Minimized screenshot refused with native cause; old input refused; UI-only stays independent.");
`;
  try {
    const result = await new PiIntegrationTest({
      testName: "window-capture-failure", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_insert"],
      conversation: [
        assistantMessage([toolCall({ id: "capture", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_insert", arguments: { path: "computer:session", text: '{"action":"close"}' } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Observe the capture failure without activating or restoring any window.");
    expect(getToolExecution(result, "capture").isError, getToolResultText(result, "capture")).toBe(false);
    expect(getToolResultText(result, "capture")).toContain("Minimized screenshot refused with native cause");
    const [, , failed, , ui] = nestedCalls(getToolExecutions(result), "capture");
    expect(failed.isError).toBe(true);
    expect(failed.computer.status).toBe("refused");
    expect(failed.computer.state.screenshot_error).toContain("minimized");
    for (const key of ["agent_image", "observation_id", "ui"]) expect(failed.computer[key]).toBeUndefined();
    expect(ui.computer).toMatchObject({ status: "observed" });
    expect(ui.computer.agent_image).toBeUndefined();
    expect(ui.computer.state.screenshot_error).toBeUndefined();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "get_window_state")).toHaveLength(3);
    expect(calls.every(c => ["fixture_identity", "list_windows", "get_window_state"].includes(c.name))).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
