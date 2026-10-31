import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { PI_COMMAND } from "./fixtures/pi-agent-ide.ts";

// The release candidate installs its archive the way `pi install` does and points this test at that install root.
const installation = process.env.PI_COMPUTER_USE_TEST_INSTALLATION;
const root = path.resolve(import.meta.dirname, "..");

function entry(name: string): { version: string; extension: string; root: string } {
  const packageRoot = path.join(installation!, "node_modules", name);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version: string; pi: { extensions: string[] } };
  return { version: manifest.version, extension: path.join(packageRoot, manifest.pi.extensions[0]!), root: packageRoot };
}

async function run(testName: string, extensions: string[], tools: string[], calls: { id: string; name: string; arguments: Record<string, unknown> }[]) {
  const cwd = await mkdtemp(path.join(root, ".tmp/installed-package-"));
  try {
    return await new PiIntegrationTest({
      testName, artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, piCommand: PI_COMMAND,
      extensions, tools, timeoutMs: 90_000,
      conversation: [...calls.map(call => assistantMessage([toolCall(call)], { stopReason: "toolUse" })), assistantMessage([text("Done.")])],
    }).run("Inspect computer use only; operate no desktop window.");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test.skipIf(!installation)("the installed package loads standalone in real Pi and ships its skill", async () => {
  const computer = entry("pi-agent-computer-use");
  const skill = readFileSync(path.join(computer.root, "skills/computer-use/SKILL.md"), "utf8");
  expect(skill).toMatch(/^---\nname: computer-use\n/);
  const result = await run("installed-standalone", [computer.extension, "builtin:tool-search"], ["tool_search"], [
    { id: "open", name: "tool_search", arguments: { query: "computer open window" } },
  ]);
  expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
  expect(getToolExecution(result, "open").isError).toBe(false);
  expect(getToolResultText(result, "open")).toContain("computer_open");
}, 120_000);

test.skipIf(!installation)("the installed package works with its installed Pi Agent IDE", async () => {
  const computer = entry("pi-agent-computer-use"), ide = entry("pi-agent-ide");
  const result = await run("installed-with-ide", [ide.extension, computer.extension, "builtin:tool-search"], ["read", "tool_search"], [
    { id: "open", name: "tool_search", arguments: { query: "computer open window" } },
    { id: "session", name: "read", arguments: { path: "computer:session" } },
  ]);
  expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
  expect(getToolResultText(result, "open")).toContain("computer_open");
  expect(getToolExecution(result, "session").isError, getToolResultText(result, "session")).toBe(false);
}, 120_000);
