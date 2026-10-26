import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi draws a held path through its points and preserves a partial stroke as unknown", async () => {
  await mkdir(".tmp/cua-drag-fork", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/cua-drag-fork/pi-path-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log],
  }));
  const code = `${SCRIPT_HELPERS}
const opened = await openApp("Notepad");
const stopped = await tools.computer_drag({window:opened.window,from:{x:20,y:30},via:[{x:40,y:80},{x:90,y:70}],to:{x:100,y:30},duration_ms:800});
if(stopped.outcome !== "unknown" || stopped.effect !== "unknown") throw Error("Lost partial path: " + stopped.text);
text(stopped.text);
text("Held path guards passed");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "held-path", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/held-path-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [
        assistantMessage([toolCall({ id: "path", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Draw only a bounded known-target path. Never replay partial input.");
    expect(getToolExecution(result, "path").isError, getToolResultText(result, "path")).toBe(false);
    expect(getToolResultText(result, "path")).toContain("Held path guards passed");
    const stopped = nestedCalls(getToolExecutions(result), "path").find(call => call.computer.status === "unknown")!.computer;
    expect(stopped.state.delivery.delivered_count).toBe(2);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const inputs = calls.filter(call => ["press_key","drag","fixture_held_path"].includes(call.name));
    expect(inputs).toEqual([{ name: "fixture_held_path", arguments: {
      pid: 42, window_id: 91, delivery_mode: "foreground", from_x: 20, from_y: 30,
      via: [{ x: 40, y: 80 }, { x: 90, y: 70 }], to_x: 100, to_y: 30, duration_ms: 800,
    } }]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
