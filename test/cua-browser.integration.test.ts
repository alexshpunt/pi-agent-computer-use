import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi Codemode forwards native PNG/JPEG and stops without replaying retired or uncertain CUA input", async () => {
  await mkdir(".tmp/cua-pivot", { recursive: true }); const cwd = await mkdtemp(path.resolve(".tmp/cua-pivot/pi-contract-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "native-cua-codemode", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/cua-browser-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "browser_open", "browser_focus", "browser_observe", "browser_act", "browser_tabs", "browser_close"],
      conversation: [
        assistantMessage([toolCall({ id: "open", name: "browser_open", arguments: { url: "https://example.test/" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "sequence", name: "codemode", arguments: { code: `
const state = await tools.browser_focus({tab:1});
store("old", state.elements[0].hint);
for(const element of state.elements.slice(0,4)) await tools.browser_act({click:element.hint,observe:false});
const view=await tools.browser_observe({});text(view.text);image(view.image);
store("fail",view.elements.find(e=>e.name==="Fail").hint);
store("refuse",view.elements.find(e=>e.name==="Refuse").hint);
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "zoom", name: "codemode", arguments: { code: `
const view=await tools.browser_observe({zoom:{x:0,y:0,width:1,height:1}});image(view.image);text(view.agent_image);
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "retired", name: "codemode", arguments: { code: `
await tools.browser_act({click:load("old"),observe:false});text("MUST NOT REACH");
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "native-refusal", name: "codemode", arguments: { code: `
await tools.browser_act({click:load("refuse"),observe:false});
await tools.browser_act({click:load("fail"),observe:false});text("MUST NOT CONTINUE");
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "uncertain", name: "codemode", arguments: { code: `
await tools.browser_act({click:load("fail"),observe:false});
await tools.browser_act({click:load("fail"),observe:false});text("MUST NOT REPLAY");
` } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "browser_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Native CUA contract checked.")]),
      ],
    }).run("Use only the focused native CUA browser tools. Stop on failure, never replay input, then close.");
    expect(getToolExecutionDetails(getToolExecution(result, "open"))).toMatchObject({ status: "observed", elements: expect.arrayContaining([expect.objectContaining({ hint: "aa" })]) });
    expect(getToolResultText(result, "sequence")).toContain("Selections: 4");
    const images = (id: string) => (getToolExecutionResult(result, id) as { content: { type: string; mimeType?: string }[] }).content.filter(b => b.type === "image");
    expect(images("sequence")).toMatchObject([{ mimeType: "image/png" }]);
    expect(images("zoom")).toMatchObject([{ mimeType: "image/jpeg" }]);
    expect(getToolExecution(result, "retired").isError).toBe(true);
    expect(getToolResultText(result, "retired")).not.toContain("MUST NOT REACH");
    expect(getToolExecution(result, "native-refusal").isError).toBe(true);
    expect(getToolResultText(result, "native-refusal")).toContain("refused");
    expect(getToolResultText(result, "native-refusal")).not.toContain("MUST NOT CONTINUE");
    expect(getToolExecution(result, "uncertain").isError).toBe(true);
    expect(getToolResultText(result, "uncertain")).toContain("unknown");
    expect(getToolResultText(result, "uncertain")).not.toContain("MUST NOT REPLAY");
    const calls = (await readFile(path.join(cwd, "cua-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "browser_prepare")).toHaveLength(1);
    const raises = calls.filter(c => c.name === "bring_to_front");
    expect(raises).toHaveLength(4);
    expect(raises.every(c => c.args.pid === 111 && c.args.window_id === 22)).toBe(true);
    expect(getToolExecutionDetails(getToolExecution(result, "open"))).toMatchObject({
      foreground: { route: "cua_bring_to_front", keyboard_focus_may_change: true },
    });
    expect(calls.filter(c => c.name === "browser_click")).toHaveLength(6);
    expect(calls.filter(c => c.name === "end_session")).toHaveLength(1);
    expect(calls.filter(c => c.name === "transport_close")).toHaveLength(1);
    expect(getToolResultText(result, "close")).toContain("released");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
