import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage, getToolExecution, getToolExecutionDetails, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

const open = { path: "computer:machine/local", text: '{"action":"open","app":"Notepad"}' };

test("real Pi restores Safe, filters foreign windows, rejects policy arguments, and opens an owned window", async () => {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp", "safe-contract-"));
  const log = path.join(cwd, "driver-calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi", "computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/fake-driver.mjs"), log],
  }));
  try {
    const result = await new PiIntegrationTest({
      testName: "safe-restoration-and-tool-boundary", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/safe-extension.ts")],
      tools: ["computer_search", "computer_insert"], isolateUserResources: true,
      conversation: [
        assistantMessage([toolCall({ id: "foreign", name: "computer_search", arguments: { path: "computer:machine/local/windows", query: "" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "promote", name: "computer_insert", arguments: { ...open, mode: "yolo" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "owned", name: "computer_insert", arguments: open })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Safe remained selected.")]),
      ],
    }).run("Exercise Safe window policy without changing the saved user choice.");
    expect(getToolExecutionDetails(getToolExecution(result, "foreign"))).toMatchObject({
      status: "listed", mode: "safe", state: { windows: [] },
    });
    expect(getToolExecution(result, "promote").isError).toBe(true);
    const owned = getToolExecutionDetails(getToolExecution(result, "owned")) as { metadata: { semanticAction: unknown } };
    expect(owned.metadata.semanticAction).toMatchObject({
      status: "observed", mode: "safe", target: { pid: 42, window_id: 101 }, opened: true,
    });
    expect(getToolExecution(result, "close").isError, getToolResultText(result, "close")).toBe(false);
    expect(getToolResultText(result, "close")).toContain("Computer closed");
    expect((getToolExecutionDetails(getToolExecution(result, "close")) as { metadata: { semanticAction: unknown } }).metadata.semanticAction)
      .toMatchObject({ status: "closed", mode: "safe" });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.name === "launch_app")).toHaveLength(1);
    expect(calls.filter(call => call.name === "get_window_state")).toHaveLength(1);
    expect(calls).toContainEqual({ event: "stdin-eof" });
    expect(result.tuiRenderedOutput).toContain("Computer: SAFE");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
