import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage, getToolCallNames, getToolExecution, getToolExecutionDetails,
  getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("standalone Pi opens two windows with first observations, rejects invented refs, and releases MCP", async () => {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp", "standalone-contract-"));
  const log = path.join(cwd, "driver-calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi", "computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/fake-driver.mjs"), log],
  }));
  try {
    const result = await new PiIntegrationTest({
      testName: "standalone-new-window-and-refusal", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/fake-extension.ts")],
      tools: ["computer_open", "computer_act", "computer_close"], isolateUserResources: true,
      conversation: [
        assistantMessage([toolCall({ id: "first", name: "computer_open", arguments: { app: "Notepad" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "second", name: "computer_open", arguments: { app: "Notepad" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "stale", name: "computer_act", arguments: {
          window_ref: "invented-ref", observation_id: "not-an-observation", action: "type_text", text: "Do not dispatch",
        } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("The standalone contract was exercised.")]),
      ],
    }).run("Open two new test windows with first observations, refuse an invented write reference, and release runtime.");
    expect(getToolCallNames(result)).toEqual(["computer_open", "computer_open", "computer_act", "computer_close"]);
    const first = getToolExecutionDetails(getToolExecution(result, "first")) as { window_ref: string };
    const second = getToolExecutionDetails(getToolExecution(result, "second")) as { window_ref: string };
    expect(first).toMatchObject({ status: "observed", opened: true, mode: "yolo", observation_id: expect.any(String),
      target: { pid: 42, window_id: 101 }, state: { elements: [{ element_token: "s1:0" }] } });
    expect(second).toMatchObject({ status: "observed", target: { pid: 42, window_id: 102 } });
    expect(second.window_ref).not.toBe(first.window_ref);
    expect(getToolExecution(result, "first").isError).toBe(false);
    expect(getToolExecution(result, "stale").isError).toBe(true);
    expect(getToolResultText(result, "stale")).toContain("Stale or missing observation_id/window_ref");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.name === "launch_app")).toHaveLength(2);
    expect(calls.filter(call => call.name === "get_window_state")).toHaveLength(2);
    expect(calls.filter(call => call.name === "type_text")).toHaveLength(0);
    expect(calls).toContainEqual({ event: "stdin-eof" });
    expect(result.tuiRenderedOutput).toContain("computer_open");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
