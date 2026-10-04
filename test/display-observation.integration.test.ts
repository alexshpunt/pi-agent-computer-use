import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

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
        tools: ["codemode", "computer_observe", "computer_act", "computer_close"],
        conversation: [
          assistantMessage([toolCall({ id: "read", name: mode === "safe" ? "computer_observe" : "codemode", arguments: mode === "safe"
            ? { display: "primary" } : { code: 'const view = await tools.computer_observe({display:"primary"}); text(view.source); image(view.image);' } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "mixed", name: "computer_observe", arguments: { display: "primary", window_ref: "w-invalid" } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "promote", name: "computer_observe", arguments: { display: "primary", mode: "yolo" } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "display-input", name: "computer_act", arguments: { window_ref: "primary", observation_id: "display-capture", action: "click", x: 0, y: 0 } })], { stopReason: "toolUse" }),
          assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
          assistantMessage([text("Read-only display source checked.")]),
        ],
      }).run("Observe the primary display only when permitted. Never change mode or use display pixels as window input.");
      const content = (getToolExecutionResult(result, "read") as { content: { type: string }[] }).content;
      if (mode === "safe") {
        expect(getToolExecutionDetails(getToolExecution(result, "read"))).toMatchObject({ status: "refused", mode: "safe" });
        expect(content.filter(block => block.type === "image")).toHaveLength(0);
      } else {
        expect(getToolResultText(result, "read")).toContain("windows-host");
        expect(content.filter(block => block.type === "image")).toHaveLength(1);
      }
      for (const id of ["mixed", "promote", "display-input"]) expect(getToolExecution(result, id).isError).toBe(true);
      const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(calls.filter(call => call.name === "get_desktop_state")).toHaveLength(mode === "safe" ? 0 : 1);
      expect(calls.filter(call => ["click", "get_window_state", "bring_to_front"].includes(call.name))).toHaveLength(0);
      if (mode === "yolo") expect(calls).toContainEqual({ name: "get_desktop_state", arguments: { max_image_dimension: 500 } });
      expect(getToolExecutionDetails(getToolExecution(result, "close"))).toMatchObject({ status: "closed", mode });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
