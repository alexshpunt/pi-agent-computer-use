import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolExecutions, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

for (const mode of ["yolo", "safe"] as const) {
  test(`real Pi ${mode} selected displays stay source-local, read-only and explicitly forwarded`, async () => {
    await mkdir(".tmp/lpt-618", { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/lpt-618/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [path.resolve("test/fixtures/selected-display-driver.mjs"), log] }));
    const discover = `const r=await tools.computer_read({path:"computer:machine/local/displays"});
const rows=r.split("\\n").filter(line=>/^computer:local\\/d\\d+[a-z]{2} /.test(line));
if(rows.length!==2)throw Error("Native discovery failed");
const row=rows.find(line=>JSON.parse(line.slice(line.lastIndexOf(" | ")+3)).bounds.x<0);
store("monitor",row.split(" | ")[0]);text(row);`;
    // Display observations are readonly: input into one refuses before dispatch and keeps it for detail.
    const observe = `${SCRIPT_HELPERS}
const r=await tools.computer_read({path:load("monitor")});
if(typeof r==="string")throw Error("Invalid read grant");
store("overview",observation(r));
const input=await insert(load("overview"),{action:"click",x:1,y:1});
if(input.outcome!=="refused"||input.effect!=="not-applied"||!/readonly/.test(input.reason))throw Error("Display pixels grounded input");
text("overview read; input refused");`;
    const crop = `const r=await tools.computer_read({path:load("overview"),views:["region:100,80,100,80"]});
if(typeof r==="string")throw Error("Selected crop failed");
image(r);text("cropped");`;
    try {
      const result = await new PiIntegrationTest({ testName: `selected-displays-${mode}`, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
        extensions: [path.resolve(`test/fixtures/selected-display-${mode === "safe" ? "safe-" : ""}extension.ts`)], isolateUserResources: true,
        tools: ["codemode", "computer_read", "computer_insert"], conversation: [
          assistantMessage([toolCall({ id: "discovery", name: mode === "safe" ? "computer_read" : "codemode", arguments: mode === "safe" ? { path: "computer:machine/local/displays" } : { code: discover } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "overview", name: mode === "safe" ? "computer_read" : "codemode", arguments: mode === "safe" ? { path: "computer:machine/local/display/d-unowned" } : { code: observe } })], { stopReason: "toolUse" }),
          ...(mode === "yolo" ? [assistantMessage([toolCall({ id: "crop", name: "codemode", arguments: { code: crop } })], { stopReason: "toolUse" })] : []),
          assistantMessage([toolCall({ id: "input", name: mode === "safe" ? "computer_insert" : "codemode", arguments: mode === "safe"
            ? { path: "computer:machine/local/display/d-unowned", text: '{"action":"click","x":1,"y":1}' }
            : { code: 'const r=await tools.computer_insert({path:load("monitor"),text:JSON.stringify({action:"click",x:1,y:1})});text(r.outcome+": "+r.reason);' } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
          assistantMessage([text("Read-only monitor selection checked.")]),
        ],
      }).run("Discover and read a selected monitor only when permitted. Do not promote display pixels to input.");
      const images = (id: string) => (getToolExecutionResult(result, id) as { content: { type: string }[] }).content.filter(b => b.type === "image");
      expect(images("discovery")).toHaveLength(0); expect(images("overview")).toHaveLength(0);
      if (mode === "safe") {
        for (const id of ["discovery", "overview"]) expect((getToolExecutionDetails(getToolExecution(result, id)) as { computer: unknown }).computer).toMatchObject({ status: "refused" });
        expect(getToolExecution(result, "input").isError).toBe(true);
      } else {
        for (const id of ["discovery", "overview", "crop", "input"]) expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
        expect(getToolResultText(result, "input")).toContain("refused: A display address accepts only resize");
        expect(images("crop")).toHaveLength(1);
        const executions = getToolExecutions(result);
        const [listed] = nestedCalls(executions, "discovery"), [overview] = nestedCalls(executions, "overview"), [crop] = nestedCalls(executions, "crop");
        const display = (listed.computer.state.displays as { bounds: { x: number }; source_identity: unknown }[]).find(item => item.bounds.x < 0)!;
        expect(display.source_identity).toBeDefined();
        expect(overview.computer.source.capabilities.input).toBe("none");
        expect(overview.computer.source.image.origin.x).toBe(0);
        expect(overview.computer.source.image.native_bounds.x).toBe(-1000);
        expect(crop.computer.source.image.origin).toMatchObject({ x: 200, y: 160 });
      }
      const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(calls.map(c => c.name)).toEqual(mode === "safe" ? [] : ["list_displays", "get_display_state", "get_display_state"]);
      if (mode === "yolo") expect(calls[2].arguments).toEqual({ display_id: "native-1", topology_id: "topology-fixture", max_image_dimension: 0 });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
