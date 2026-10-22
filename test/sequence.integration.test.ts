import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionResult, getToolExecutions, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi stores a sequence without images and forwards only explicitly selected Codemode frames", async () => {
  await mkdir(".tmp/lpt-616", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-616/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/detail-driver.mjs"), log] }));
  const capture = `${SCRIPT_HELPERS}
const result=await tools.computer_read({path:"computer:display/primary",views:['sequence:{"duration_ms":3000,"fps":2,"max_frames":3}']});
if(typeof result!=="string")throw Error("Capture unexpectedly forwarded frames");
store("temporal",address(result,"sequence","Sequence"));text(result.match(/^Frames: .*$/m)[0]);`;
  const select = `const result=await tools.computer_read({path:load("temporal"),views:['frames:{"indexes":[0,2]}']});
if(result.type!=="images"||result.images.length!==2)throw Error("Selection failed");
if(!/Selected frames: 0, 2; readonly, input=none/.test(result.note))throw Error("Frames ground input");
for(const frame of result.images)image(frame);
text("Only selected temporal frames forwarded");`;
  try {
    const result = await new PiIntegrationTest({ testName: "temporal-sequence", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_insert"], conversation: [
        assistantMessage([toolCall({ id: "capture", name: "codemode", arguments: { code: capture } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "select", name: "codemode", arguments: { code: select } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_insert", arguments: { path: "computer:session", text: '{"action":"close"}' } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Capture a bounded temporal resource, then forward exactly frames zero and two, without input.");
    expect(getToolExecution(result, "capture").isError, getToolResultText(result, "capture")).toBe(false);
    expect((getToolExecutionResult(result, "capture") as { content: { type: string }[] }).content.some(b => b.type === "image")).toBe(false);
    expect(getToolExecution(result, "select").isError, getToolResultText(result, "select")).toBe(false);
    expect((getToolExecutionResult(result, "select") as { content: { type: string }[] }).content.filter(b => b.type === "image")).toHaveLength(2);
    expect(getToolResultText(result, "select")).toContain("Only selected temporal frames forwarded");
    const [selected] = nestedCalls(getToolExecutions(result), "select");
    const frames = selected.computer.selected_frames as { index: number; source: { capabilities: { input: string } } }[];
    expect(frames.map(frame => frame.index)).toEqual([0, 2]);
    expect(frames.every(frame => frame.source.capabilities.input === "none")).toBe(true);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "get_desktop_state")).toHaveLength(3);
    expect(calls.every(c => c.name === "get_desktop_state")).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
