import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

test("production Pi exposes only computer tools, with no direct or Codemode browser route", async () => {
  await mkdir(".tmp/unified-tools", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/unified-tools/pi-contract-"));
  const log = path.join(cwd, "driver-calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/fake-driver.mjs"), log],
  }));
  try {
    const result = await new PiIntegrationTest({
      testName: "unified-production-tools", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/unified-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "registered_ui_tools", "computer_apps", "computer_open", "computer_windows",
        "computer_observe", "computer_act", "computer_close"],
      conversation: [
        assistantMessage([toolCall({ id: "registry", name: "registered_ui_tools", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "direct-browser", name: "browser_tabs", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "nested-browser", name: "codemode",
          arguments: { code: "text(await tools.browser_tabs({}));" } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "apps", name: "codemode",
          arguments: { code: 'text(await tools.computer_apps({query:"Notepad"}));' } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Unified tool loadout checked.")]),
      ],
    }).run("Check the production loadout. Only discover apps; never open a window or send input.");
    const expected = ["computer_act", "computer_apps", "computer_close", "computer_observe", "computer_open", "computer_windows"];
    expect(getToolExecutionDetails(getToolExecution(result, "registry"))).toEqual({
      names: [...expected, "computer_classify", "computer_sequence"].sort(), callable: expected,
    });
    for (const id of ["direct-browser", "nested-browser"]) {
      expect(getToolExecution(result, id).isError).toBe(true);
      expect(getToolResultText(result, id)).toContain(id === "direct-browser" ? "browser_tabs" : "No tool calls were made.");
    }
    expect(getToolExecution(result, "apps").isError).toBe(false);
    expect(getToolResultText(result, "apps")).toContain("Notepad");
    expect(getToolExecution(result, "close").isError).toBe(false);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.name)).toEqual([{ name: "list_apps", arguments: {} }]);
    expect(calls).toContainEqual({ event: "stdin-eof" });
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
