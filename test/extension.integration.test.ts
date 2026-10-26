import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage, getToolCallNames, getToolExecution, getToolExecutionDetails,
  getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

type Action = { metadata: { semanticAction: Record<string, unknown> } };
const action = (details: unknown) => (details as Action).metadata.semanticAction;
const open = (id: string) => toolCall({ id, name: "computer_open", arguments: { at: "computer:machine/local", app: "Notepad" } });

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
      tools: ["computer_open", "computer_type", "computer_delete"], isolateUserResources: true,
      conversation: [
        assistantMessage([open("first")], { stopReason: "toolUse" }),
        assistantMessage([open("second")], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "stale", name: "computer_type", arguments: {
          window: "computer:window/not-a-window", text: "Do not dispatch",
        } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("The standalone contract was exercised.")]),
      ],
    }).run("Open two new test windows with first observations, refuse an invented window reference, and release runtime.");
    expect(getToolCallNames(result)).toEqual(["computer_open", "computer_open", "computer_type", "computer_delete"]);
    const first = action(getToolExecutionDetails(getToolExecution(result, "first")));
    const second = action(getToolExecutionDetails(getToolExecution(result, "second")));
    expect(first).toMatchObject({ status: "observed", opened: true, mode: "yolo", observation_id: expect.any(String),
      target: { pid: 42, window_id: 101 }, state: { elements: [{ element_token: "s1:0" }] } });
    expect(second).toMatchObject({ status: "observed", target: { pid: 42, window_id: 102 } });
    expect(second.window_ref).not.toBe(first.window_ref);
    // The text shows this run's short addresses (LPT-932); the long references stay in the details.
    expect(getToolResultText(result, "first")).toMatch(/^Window: computer:local\/w1[a-z]{2}\nObservation: computer:local\/o1[a-z]{2}$/m);
    expect(getToolExecution(result, "first").isError).toBe(false);
    expect(getToolExecution(result, "stale").isError).toBe(true);
    expect(getToolResultText(result, "stale")).toContain("Unknown or closed window reference");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.name === "launch_app")).toHaveLength(2);
    expect(calls.filter(call => call.name === "get_window_state")).toHaveLength(2);
    expect(calls.filter(call => call.name === "type_text")).toHaveLength(0);
    expect(calls).toContainEqual({ event: "stdin-eof" });
    expect(result.tuiRenderedOutput).toContain("computer_open");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
