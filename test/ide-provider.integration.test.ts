import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { IDE_EXTENSION, PI_COMMAND } from "./fixtures/pi-agent-ide.ts";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "test/fixtures/ide-provider-extension.ts");
const driver = path.join(root, "test/fixtures/ide-provider-driver.mjs");
const inputNames = ["type_text", "click", "press_key", "hotkey"];

// Pattern: real-Pi extensions example and Linear/GitHub public-provider loading tests.
// Contract: the IDE tools read and the computer_* tools act; they preserve native capture identity and literal input, and Write/Insert refuse.
// IDE is this feature's consumer, not an unrelated latest/clean checkout gate.
test.each([false, true])(
  "IDE Read and the computer_* tools preserve literal text, native images and scopes (providerFirst=%s)",
  async (providerFirst) => {
    await runScenario(providerFirst, "workflow");
  },
  120_000,
);

test.each([false, true])(
  "the computer_* tools refuse unauthorized, closed and interrupted input in the IDE (providerFirst=%s)",
  async (providerFirst) => {
    await runScenario(providerFirst, "admission");
  },
  120_000,
);

async function runScenario(providerFirst: boolean, scenario: "workflow" | "admission") {
  const extension = IDE_EXTENSION;
  await mkdir(path.join(root, ".tmp/lpt-750"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/lpt-750/pi-provider-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [driver, path.join(cwd, "calls.jsonl")] }));
    const result = await new PiIntegrationTest({
      testName: `ide-computer-${scenario}-${providerFirst ? "provider-first" : "core-first"}`,
      artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, rawMode: false,
      piCommand: PI_COMMAND,
      extensions: providerFirst ? [fixture, extension] : [extension, fixture],
      tools: ["read", "search", "write", "insert", "delete", "verify_ide_computer"],
      timeoutMs: 90_000,
      conversation: [assistantMessage([toolCall({ id: "computer-proof", name: "verify_ide_computer", arguments: { scenario } })], { stopReason: "toolUse" }),
        assistantMessage([text("Finished the synthetic IDE computer fixture.")])],
    }).run("Use ordinary IDE resource tools against the synthetic MCP fixture only. Do not operate real desktop windows or replay unknown input.");
    expect(getToolExecution(result, "computer-proof").isError, getToolResultText(result, "computer-proof")).toBe(false);
    expect(getToolResultText(result, "computer-proof")).toContain(`IDE computer ${scenario} contract passed`);
    expect((getToolExecution(result, "computer-proof").result as { content?: { type: string }[] }).content?.some(block => block.type === "image")).toBe(true);
    const details = getToolExecutionDetails(getToolExecution(result, "computer-proof")) as { nativeCaptures: number; localText?: string };
    expect(details.nativeCaptures).toBeGreaterThan(2);
    const calls = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const inputs = calls.filter(row => inputNames.includes(row.name));
    expect(inputs.map(row => row.name)).toEqual(scenario === "workflow" ? ["type_text", "click"] : ["type_text"]);
    for (const row of inputs) expect(row.arguments.target).toEqual({ kind: "window", pid: 42, window_id: 91 });
    if (scenario === "workflow") {
      expect(inputs[0].arguments).toMatchObject({ text: '  {"looks":"like JSON"}\n"quoted text"\n  ', delay_ms: 0, delivery_mode: "foreground", element_token: expect.any(String) });
      expect(calls.filter(row => row.name === "zoom")).toEqual([{ name: "zoom", arguments: { pid: 42, window_id: 91, x1: 80, y1: 60, x2: 120, y2: 80 } }]);
      expect(details.localText).toBe("Local source stays local\nSecond local line");
    }
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
    expect(result.tuiRenderedOutput).not.toContain("already handles");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
