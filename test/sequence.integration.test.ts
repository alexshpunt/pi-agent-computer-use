import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("real Pi stores a sequence without images and forwards only explicitly selected Codemode frames", async () => {
  await mkdir(".tmp/lpt-616", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-616/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/detail-driver.mjs"), log] }));
  const capture = `const result=await tools.computer_sequence({display:"primary",capture:{duration_ms:3000,fps:2,max_frames:3}});
if(result.status!=="observed"||result.image||result.frames)throw Error("Capture unexpectedly forwarded frames");
store("temporal",result.sequence.sequence_id);text({count:result.sequence.frames.length,stop:result.sequence.stop_reason});`;
  const select = `const result=await tools.computer_sequence({sequence_id:load("temporal"),selection:{indexes:[0,2]}});
if(result.status!=="observed"||result.frames.length!==2)throw Error("Selection failed");
for(const frame of result.frames){if(frame.source.capabilities.input!=="none")throw Error("Frame grounds input");text({index:frame.index,time:frame.timestamp_ms});image(frame.image)}
text("Only selected temporal frames forwarded");`;
  try {
    const result = await new PiIntegrationTest({ testName: "temporal-sequence", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_sequence", "computer_close"], conversation: [
        assistantMessage([toolCall({ id: "capture", name: "codemode", arguments: { code: capture } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "select", name: "codemode", arguments: { code: select } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Capture a bounded temporal resource, then forward exactly frames zero and two, without input.");
    expect(getToolExecution(result, "capture").isError).toBe(false);
    expect((getToolExecutionResult(result, "capture") as { content: { type: string }[] }).content.some(b => b.type === "image")).toBe(false);
    expect(getToolExecution(result, "select").isError).toBe(false);
    expect((getToolExecutionResult(result, "select") as { content: { type: string }[] }).content.filter(b => b.type === "image")).toHaveLength(2);
    expect(getToolResultText(result, "select")).toContain("Only selected temporal frames forwarded");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "get_desktop_state")).toHaveLength(3);
    expect(calls.every(c => c.name === "get_desktop_state")).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
