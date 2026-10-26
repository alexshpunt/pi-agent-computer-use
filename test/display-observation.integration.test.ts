import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolExecutions, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { DEFAULT_MAX_LONG_EDGE } from "../src/cua-image-settings.ts";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

const yoloRead = `${SCRIPT_HELPERS}
const view = await tools.computer_read({path:"computer:machine/local/display/primary"});
text(body(view)); image(view);
const input = await insert(observation(view),{action:"click",x:0,y:0});
text("observation input: " + input.outcome + " / " + input.effect);`;

for (const mode of ["yolo", "safe"] as const) {
  test(`real Pi ${mode} display observation keeps source permission and Codemode image delivery separate from input`, async () => {
    await mkdir(".tmp/display-observation", { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/display-observation/pi-contract-"));
    const log = path.join(cwd, "driver-calls.jsonl");
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
      command: process.execPath, args: [path.resolve("test/fixtures/fake-driver.mjs"), log],
    }));
    try {
      const result = await new PiIntegrationTest({
        testName: `primary-display-${mode}`, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
        extensions: [path.resolve(`test/fixtures/${mode === "safe" ? "safe" : "display"}-extension.ts`)], isolateUserResources: true,
        tools: ["codemode", "computer_read", "computer_insert"],
        conversation: [
          assistantMessage([toolCall({ id: "read", name: mode === "safe" ? "computer_read" : "codemode", arguments: mode === "safe"
            ? { path: "computer:machine/local/display/primary" } : { code: yoloRead } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "mixed", name: "computer_read", arguments: { path: "computer:machine/local/display/primary", views: ["ui"] } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "promote", name: "computer_read", arguments: { path: "computer:machine/local/display/primary", mode: "yolo" } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "display-input", name: "computer_insert", arguments: { path: "computer:machine/local/display/primary", text: '{"action":"click","x":0,"y":0}' } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "close", name: "computer_insert", arguments: { path: "computer:session", text: '{"action":"close"}' } })], { stopReason: "toolUse" }),
          assistantMessage([text("Read-only display source checked.")]),
        ],
      }).run("Observe the primary display only when permitted. Never change mode or use display pixels as window input.");
      const content = (getToolExecutionResult(result, "read") as { content: { type: string }[] }).content;
      if (mode === "safe") {
        expect(getToolExecution(result, "read").isError).toBe(true);
        expect((getToolExecutionDetails(getToolExecution(result, "read")) as { computer: unknown }).computer).toMatchObject({ status: "refused", mode: "safe" });
        expect(content.filter(block => block.type === "image")).toHaveLength(0);
      } else {
        expect(getToolExecution(result, "read").isError, getToolResultText(result, "read")).toBe(false);
        expect(content.filter(block => block.type === "image")).toHaveLength(1);
        expect(getToolResultText(result, "read")).toContain("observation input: refused / not-applied");
        const [read] = nestedCalls(getToolExecutions(result), "read");
        expect(read.computer.source.domain).toBe("windows-host");
      }
      for (const id of ["mixed", "promote", "display-input"]) expect(getToolExecution(result, id).isError).toBe(true);
      const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(calls.filter(call => call.name === "get_desktop_state")).toHaveLength(mode === "safe" ? 0 : 1);
      expect(calls.filter(call => ["click", "get_window_state", "bring_to_front"].includes(call.name))).toHaveLength(0);
      if (mode === "yolo") expect(calls).toContainEqual({ name: "get_desktop_state", arguments: { max_image_dimension: DEFAULT_MAX_LONG_EDGE } });
      expect(getToolExecution(result, "close").isError, getToolResultText(result, "close")).toBe(false);
      expect(getToolResultText(result, "close")).toContain("Computer closed");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
