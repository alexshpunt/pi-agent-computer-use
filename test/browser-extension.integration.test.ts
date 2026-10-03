import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi Codemode runs four focused hints without captures and stops after refusal", async () => {
  await mkdir(".tmp", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp", "browser-contract-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "focused-browser-codemode", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/browser-extension.ts")],
      tools: ["codemode", "browser_open", "browser_focus", "browser_observe", "browser_act", "browser_tabs", "browser_close"],
      isolateUserResources: true,
      conversation: [
        assistantMessage([toolCall({ id: "open", name: "browser_open", arguments: { url: "https://example.test" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "sequence", name: "codemode", arguments: { code: `
const state = await tools.browser_focus({tab:1});
store("hint", state.elements[0].hint);
for (const element of state.elements.slice(0,4)) text(await tools.browser_act({click:element.hint}));
const view = await tools.browser_observe({});
text(view.text); image(view.image);
store("failure", view.elements.find(element=>element.name==="fail").hint);
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "stop", name: "codemode", arguments: { code: `
await tools.browser_act({click:"neverallocated"});
await tools.browser_act({click:load("hint")});
text("MUST NOT REACH");
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "partial", name: "codemode", arguments: { code: `
await tools.browser_act({click:load("failure")});
await tools.browser_act({click:load("failure")});
text("MUST NOT REPLAY");
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "mixed", name: "browser_act", arguments: { click: "a", scroll: 100 } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "attach", name: "browser_open", arguments: { url: "https://example.test", profile: "personal" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "browser_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("The focused browser contract was checked.")]),
      ],
    }).run("Use the focused owned browser in Pi Codemode, stop on refusal, then close.");
    expect(getToolExecutionDetails(getToolExecution(result, "open"))).toMatchObject({ status: "observed", tab: 1 });
    expect(getToolExecutionDetails(getToolExecution(result, "open"))).toMatchObject({ elements: expect.arrayContaining([expect.objectContaining({ hint: "aa" })]) });
    expect(getToolExecutionResult(result, "open")).toMatchObject({ content: expect.arrayContaining([expect.objectContaining({ type: "image", mimeType: "image/png" })]) });
    expect(getToolResultText(result, "sequence")).toContain("Selections: 4");
    expect((getToolExecutionResult(result, "sequence") as { content: { type: string }[] }).content.filter(block => block.type === "image")).toHaveLength(1);
    expect(getToolExecution(result, "sequence").isError).toBe(false);
    expect(getToolExecution(result, "stop").isError).toBe(true);
    expect(getToolResultText(result, "stop")).not.toContain("MUST NOT REACH");
    expect(getToolExecution(result, "partial").isError).toBe(true);
    expect(getToolResultText(result, "partial")).toContain("Outcome unknown");
    expect(getToolResultText(result, "partial")).not.toContain("MUST NOT REPLAY");
    expect(getToolExecution(result, "mixed").isError).toBe(true);
    expect(getToolExecution(result, "attach").isError).toBe(true);
    expect(getToolResultText(result, "close")).toContain("Owned browser closed");
    const calls = (await readFile(path.join(cwd, "browser-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.event === "open")).toHaveLength(1);
    expect(calls.filter(call => call.event === "observe")).toHaveLength(3);
    expect(calls.filter(call => call.event === "input")).toHaveLength(5);
    expect(calls).toContainEqual({ event: "stdin-eof" });
    expect(result.tuiRenderedOutput).toContain("codemode");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
