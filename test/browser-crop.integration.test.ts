import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionResult, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi CodeMode crops original pixels without capture and stops stale input before dispatch", async () => {
  await mkdir(".tmp", { recursive: true }); const cwd = await mkdtemp(path.resolve(".tmp", "crop-contract-"));
  try {
    const run = await new PiIntegrationTest({ testName: "original-frame-crop", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/crop-extension.ts")], tools: ["codemode", "browser_open", "browser_observe", "browser_act", "browser_close"],
      conversation: [
        assistantMessage([toolCall({ id: "open", name: "browser_open", arguments: { url: "https://example.test" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "detail", name: "codemode", arguments: { code: `
const v=await tools.browser_observe({crop:{x:50,y:20,width:100,height:50,maxLongEdge:1000}});
image(v.image);text(v.agent_image);store("root",v.agent_image.origin.observation);
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "history", name: "codemode", arguments: { code: `
await tools.browser_act({scroll:20,observe:false});
const v=await tools.browser_observe({crop:{x:0,y:0,width:100,height:50,maxLongEdge:800,scale:0.5}});
image(v.image);text(v.agent_image.origin);
await tools.browser_act({click:{x:10,y:10}});
text("MUST NOT DISPATCH");
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "browser_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "expired", name: "codemode", arguments: { code: `await tools.browser_observe({crop:{x:0,y:0,width:1,height:1}});` } })], { stopReason: "toolUse" }),
        assistantMessage([text("Crop contract complete.")]),
      ],
    }).run("Qualify saved original-frame crops through CodeMode on the synthetic owned fixture.");
    expect(getToolExecution(run, "detail").isError).toBe(false);
    expect((getToolExecutionResult(run, "detail") as { content: { type: string }[] }).content.some(block => block.type === "image")).toBe(true);
    expect(getToolExecution(run, "history").isError).toBe(true);
    expect(getToolResultText(run, "history")).not.toContain("MUST NOT DISPATCH");
    expect(getToolExecution(run, "expired").isError).toBe(true);
    const calls = (await readFile(path.join(cwd, "crop-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(row => row.event === "capture")).toHaveLength(1);
    expect(calls.filter(row => row.event === "open")).toHaveLength(1);
    expect(calls.filter(row => row.event === "input")).toEqual([{ event: "input", data: expect.objectContaining({ action: "scroll" }) }]);
    const state = JSON.parse(await readFile(path.join(cwd, "crop-trace.json"), "utf8"));
    const crops = state.captures.filter((frame: { source: { saved_crop?: boolean } }) => frame.source?.saved_crop);
    expect(crops).toHaveLength(2);
    expect(crops[0].source.origin.observation).toBe(crops[1].source.origin.observation);
    expect(crops[1].source.origin.inputReady).toBe(false);
    expect(crops.every((frame: { original: string }) => frame.original === "available")).toBe(true);
    expect(run.tuiRenderedOutput).toContain("codemode");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
