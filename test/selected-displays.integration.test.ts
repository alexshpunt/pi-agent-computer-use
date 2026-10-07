import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

for (const mode of ["yolo", "safe"] as const) {
  test(`real Pi ${mode} selected displays stay source-local, read-only and explicitly forwarded`, async () => {
    await mkdir(".tmp/lpt-618", { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/lpt-618/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [path.resolve("test/fixtures/selected-display-driver.mjs"), log] }));
    const discover = `const r=await tools.computer_displays({});
if(r.status!=="listed"||r.state.displays.length!==2)throw Error("Native discovery failed");
const d=r.state.displays.find(d=>d.bounds.x<0);store("monitor",d.display_ref);text(d.source_identity);`;
    const observe = `const r=await tools.computer_observe({display:load("monitor")});
if(r.status!=="observed"||r.observation_id||r.source.capabilities.input!=="none")throw Error("Invalid read grant");
if(r.source.image.origin.x!==0||r.source.image.native_bounds.x!==-1000)throw Error("Coordinate domains mixed");
store("overview",r.agent_image.image_id);text(r.source);`;
    const crop = `const r=await tools.computer_observe({display:load("monitor"),zoom:{image_id:load("overview"),x:100,y:80,width:100,height:80}});
if(r.status!=="observed"||r.source.image.origin.x!==200||r.source.image.origin.y!==160)throw Error("Selected crop failed");
text(r.source);image(r.image);`;
    try {
      const result = await new PiIntegrationTest({ testName: `selected-displays-${mode}`, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
        extensions: [path.resolve(`test/fixtures/selected-display-${mode === "safe" ? "safe-" : ""}extension.ts`)], isolateUserResources: true,
        tools: ["codemode", "computer_displays", "computer_observe", "computer_act", "computer_close"], conversation: [
          assistantMessage([toolCall({ id: "discovery", name: mode === "safe" ? "computer_displays" : "codemode", arguments: mode === "safe" ? {} : { code: discover } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "overview", name: mode === "safe" ? "computer_observe" : "codemode", arguments: mode === "safe" ? { display: "d-unowned" } : { code: observe } })], { stopReason: "toolUse" }),
          ...(mode === "yolo" ? [assistantMessage([toolCall({ id: "crop", name: "codemode", arguments: { code: crop } })], { stopReason: "toolUse" })] : []),
          assistantMessage([toolCall({ id: "input", name: mode === "safe" ? "computer_act" : "codemode", arguments: mode === "safe"
            ? { window_ref: "d-unowned", observation_id: "none", action: "click", x: 1, y: 1 }
            : { code: 'const r=await tools.computer_act({window_ref:load("monitor"),observation_id:load("overview"),action:"click",x:1,y:1});text(r);' } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
          assistantMessage([text("Read-only monitor selection checked.")]),
        ],
      }).run("Discover and read a selected monitor only when permitted. Do not promote display pixels to input.");
      const images = (id: string) => (getToolExecutionResult(result, id) as { content: { type: string }[] }).content.filter(b => b.type === "image");
      expect(images("discovery")).toHaveLength(0); expect(images("overview")).toHaveLength(0);
      if (mode === "safe") {
        for (const id of ["discovery", "overview", "input"]) expect(getToolExecutionDetails(getToolExecution(result, id))).toMatchObject({ status: "refused" });
      } else {
        for (const id of ["discovery", "overview", "crop"]) expect(getToolExecution(result, id).isError).toBe(false);
        expect(getToolExecution(result, "input").isError).toBe(true);
        expect(getToolResultText(result, "input")).toContain("Stale or missing observation_id/window_ref");
        expect(images("crop")).toHaveLength(1);
      }
      const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(calls.map(c => c.name)).toEqual(mode === "safe" ? [] : ["list_displays", "get_display_state", "get_display_state"]);
      if (mode === "yolo") expect(calls[2].arguments).toEqual({ display_id: "native-1", topology_id: "topology-fixture", max_image_dimension: 0 });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
