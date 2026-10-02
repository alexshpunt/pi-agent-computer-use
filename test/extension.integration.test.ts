import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage, getToolCallNames, getToolExecution, getToolExecutionDetails,
  getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("standalone Pi loads observation tools, refuses a stale action, and releases its MCP child", async () => {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp", "standalone-contract-"));
  const log = path.join(cwd, "driver-calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi", "computer-use.json"), JSON.stringify({
    command: process.execPath,
    args: [path.resolve("test/fixtures/fake-driver.mjs"), log],
    target: { pid: 42, window_id: 100 },
  }));
  try {
    const result = await new PiIntegrationTest({
      testName: "standalone-observation-and-refusal",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/index.ts")],
      tools: ["computer_windows", "computer_observe", "computer_act", "computer_close"],
      isolateUserResources: true,
      conversation: [
        assistantMessage([toolCall({ id: "find", name: "computer_windows", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "read", name: "computer_observe", arguments: { target: { pid: 42, window_id: 100 } } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "stale", name: "computer_act", arguments: {
          target: { pid: 42, window_id: 100 }, observation_id: "not-an-observation",
          action: "type_text", element_token: "s1:0", text: "Do not dispatch",
        } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("The standalone contract was exercised.")]),
      ],
    }).run("Read only the configured test window, refuse a stale write, and close the owned runtime.");
    expect(getToolCallNames(result)).toEqual(["computer_windows", "computer_observe", "computer_act", "computer_close"]);
    expect(getToolExecution(result, "read").isError).toBe(false);
    expect(getToolExecutionDetails(getToolExecution(result, "read"))).toMatchObject({
      status: "observed", observation_id: expect.any(String),
      state: { elements: [{ element_token: "s1:0" }] },
    });
    expect(getToolResultText(result, "read")).toContain("Fresh window observation");
    expect(getToolExecution(result, "stale").isError).toBe(true);
    expect(getToolResultText(result, "stale")).toContain("Stale or missing observation_id");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.name).map((call) => call.name)).toEqual(["list_windows", "get_window_state"]);
    expect(calls).toContainEqual({ event: "stdin-eof" });
    expect(result.tuiRenderedOutput).toContain("computer_observe");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
