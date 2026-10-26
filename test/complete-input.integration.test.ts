import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi sends keys, chords and drags in the background and keeps partial and refused outcomes apart", async () => {
  await mkdir(".tmp/cua-gestures", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/cua-gestures/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log],
  }));
  const code = `${SCRIPT_HELPERS}
const opened = await openApp("Notepad");
if (opened.outcome !== "observed" || !opened.window || !opened.observation) throw Error("Open returned no window and observation");
if (!(await windows()).includes(opened.window)) throw Error("Discovery lost the opened window");
const press = (key, extra) => tools.computer_press({window:opened.window,key,...extra});
for (const key of ["a","shift+b"]) if ((await press(key)).outcome !== "delivered") throw Error("Key refused: " + key);
const drag = await tools.computer_drag({window:opened.window,from:{x:30,y:40},to:{x:100,y:80},duration_ms:100});
if (drag.outcome !== "delivered") throw Error("Drag refused: " + drag.text);
const partial = await press("escape");
if (partial.outcome !== "unknown" || partial.effect !== "unknown") throw Error("Partial key reported as " + partial.outcome);
text(partial.text);
const refused = await press("delete", {foreground:false});
if (refused.outcome !== "refused" || refused.effect !== "not-applied") throw Error("Background refusal reported as " + refused.outcome);
text(refused.text);
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
    }).run("Send known keys and a drag. Never replay uncertain input.");
    expect(getToolExecution(result, "sequence").isError, getToolResultText(result, "sequence")).toBe(false);
    expect(getToolResultText(result, "sequence")).toContain("Complete sequence guards passed");
    const nested = nestedCalls(getToolExecutions(result), "sequence");
    const [opened, discovery] = nested;
    expect(discovery.computer.state.windows[0].source_identity).toEqual(opened.computer.source_identity);
    expect(opened.computer.source.identity.session_id).toBe(opened.computer.source_identity.identity.session_id);
    expect(opened.computer.source.membership).toMatchObject({ monitor_id: null, virtual_desktop_id: null });
    const presses = nested.filter(call => call.name === "computer_press").map(call => call.computer);
    expect(presses.map(item => item.status)).toEqual(["delivered", "delivered", "unknown", "refused"]);
    expect(presses[3].action_capability).toMatchObject({ background: "unavailable", foreground: "suggested" });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const input = calls.filter(c => ["press_key", "hotkey", "drag"].includes(c.name));
    expect(input.map(c => c.name)).toEqual(["press_key", "hotkey", "drag", "press_key", "press_key"]);
    expect(input.map(c => c.arguments.key ?? c.arguments.keys)).toEqual(["a", ["shift", "b"], undefined, "escape", "delete"]);
    expect(input.map(c => c.arguments.target)).toEqual(Array(5).fill({ kind: "window", pid: 42, window_id: 91 }));
    expect(input.every(c => c.arguments.delivery_mode === "background")).toBe(true);
    expect(calls.some(c => c.name === "bring_to_front")).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
