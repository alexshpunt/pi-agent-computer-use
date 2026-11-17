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

test("Codemode composes IDE computer reads, image writes and provider search", async () => {
  await mkdir(path.join(root, ".tmp/lpt-1405"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/lpt-1405/pi-provider-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [driver, path.join(cwd, "calls.jsonl")] }));
    const code = `const opened = await tools.computer_open({ at: "computer:machine/local", app: "Notepad" });
const found = await tools.search({ path: "computer:machine/local/windows", query: "Owned fixture" });
if (typeof found !== "string" || !found.includes(opened.window)) throw Error("window search lost its address");
const ui = await tools.read({ path: opened.window, views: ["ui"] });
if (!ui || typeof ui.id !== "string" || !ui.text.includes("Fixture text field")) throw Error("UI text value missing");
const shot = await tools.read({ path: opened.window });
if (!shot || shot.type !== "image" || shot.mimeType !== "image/png") throw Error("window image missing");
await tools.write({ path: "snapshot.png", image: shot });
const missing = await tools.read({ path: "missing-file-for-codemode-test" });
if (missing !== null) throw Error("failed IDE Read did not return null");
text(JSON.stringify({ ui: ui.text.includes("Fixture button"), image: shot.type, continued: true }));`;
    const result = await new PiIntegrationTest({
      testName: "ide-computer-codemode-values", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      isolateUserResources: true, rawMode: false, piCommand: PI_COMMAND,
      extensions: [IDE_EXTENSION, fixture, path.join(root, "test/fixtures/codemode-extension.ts")],
      tools: ["read", "search", "write", "codemode", "computer_open"], timeoutMs: 90_000,
      conversation: [assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")])],
    }).run("Use the synthetic computer fixture.");
    expect(getToolExecution(result, "script").isError, getToolResultText(result, "script")).toBe(false);
    expect(getToolResultText(result, "script")).toContain('{"ui":true,"image":"image","continued":true}');
    expect((await readFile(path.join(cwd, "snapshot.png"))).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 120_000);

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
      expect(calls.filter(row => row.name === "zoom")).toEqual([{ name: "zoom", arguments: { pid: 42, window_id: 91, x1: 80, y1: 60, x2: 160, y2: 100 } }]);
      expect(details.localText).toBe("Local source stays local\nSecond local line");
    }
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
    expect(result.tuiRenderedOutput).not.toContain("already handles");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
