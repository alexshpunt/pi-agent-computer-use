import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

// This checks the real Pi/MCP boundary, not native Windows application behavior.
test("real Pi binds a drag to the latest capture and refuses it after the window changed size until it is read again", async () => {
  await mkdir(".tmp/lpt-619", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-619/pi-capture-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log, "capture-drag"] }));
  const code = `${SCRIPT_HELPERS}
const opened = await openApp("Notepad");
const drag = () => tools.computer_drag({window:opened.window,from:{x:30,y:40},to:{x:100,y:80},duration_ms:100});
if((await drag()).outcome!=="delivered") throw Error("Drag on the first capture refused");
if((await tools.computer_press({window:opened.window,key:"r"})).outcome!=="delivered") throw Error("Key refused");
await windows();
const stale=await drag();
if(stale.outcome!=="refused" || stale.code!=="capture_frame_mismatch" || stale.effect!=="not-applied") throw Error("Resize refusal lost: "+stale.text);
await tools.computer_read({path:opened.window});
const fresh=await drag();
if(fresh.outcome!=="delivered") throw Error("Fresh capture drag refused: "+fresh.text);
text("Capture-bound drag refusal and fresh recovery passed");`;
  try {
    const result = await new PiIntegrationTest({ testName: "capture-bound-drag", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/capture-drag-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [assistantMessage([toolCall({ id: "drag", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")])],
    }).run("Use the synthetic MCP capture fixture; stop after resize refusal and observe before trying fresh input.");
    expect(getToolExecution(result, "drag").isError, getToolResultText(result, "drag")).toBe(false);
    expect(getToolResultText(result, "drag")).toContain("Capture-bound drag refusal and fresh recovery passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const input = calls.filter(c => ["press_key", "drag"].includes(c.name));
    expect(input.map(c => c.name)).toEqual(["drag", "press_key", "drag", "drag"]);
    // Each drag names the latest capture before it; the stale one carries the capture taken before the window grew.
    const latest = (index: number) => calls.slice(0, index).filter(c => c.name === "get_window_state").length;
    const drags = calls.flatMap((c, index) => c.name === "drag" ? [{ args: c.arguments, capture: `capture-${latest(index)}` }] : []);
    for (const drag of drags) expect(drag.args).toEqual({ target: { kind: "window", pid: 42, window_id: 91 }, delivery_mode: "background",
      capture_id: drag.capture, from_x: 30, from_y: 40, to_x: 100, to_y: 80, duration_ms: 100 });
    expect(calls.some(c => c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
