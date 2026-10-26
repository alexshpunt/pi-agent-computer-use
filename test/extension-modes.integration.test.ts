import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage, getToolCallNames, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { IDE_EXTENSION, PI_COMMAND } from "./fixtures/pi-agent-ide.ts";

const root = path.resolve(import.meta.dirname, "..");
const computerUse = path.join(root, "src/index.ts");
const ide = IDE_EXTENSION;

async function run(name: string, extensions: string[], tools: string[], calls: { id: string; name: string; arguments: Record<string, unknown> }[]) {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/extension-modes-"));
  try {
    return await new PiIntegrationTest({
      testName: name, artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true,
      piCommand: PI_COMMAND, extensions, tools, timeoutMs: 90_000,
      conversation: [
        ...calls.map(call => assistantMessage([toolCall({ ...call, delayMs: 0 })], { stopReason: "toolUse" })),
        assistantMessage([text("Done.")]),
      ],
    }).run("Use computer use only through the session address; operate no desktop window.");
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("without Pi Agent IDE, tool_search finds the deferred computer tools and they work", async () => {
  const result = await run("standalone", ["builtin:tool-search", computerUse], ["read"], [
    { id: "find", name: "tool_search", arguments: { query: "computer read windows displays" } },
    { id: "guide", name: "computer_read", arguments: { path: "docs:computer" } },
    { id: "session", name: "computer_read", arguments: { path: "computer:session" } },
    { id: "close", name: "computer_insert", arguments: { path: "computer:session", text: '{"action":"close"}' } },
    { id: "more", name: "tool_search", arguments: { query: "computer wait browser" } },
    { id: "display", name: "computer_display", arguments: { display: "computer:display/primary", width: 1920, height: 1080 } },
    { id: "delete", name: "computer_delete", arguments: { path: "computer:session" } },
  ]);
  expect(getToolCallNames(result)).toEqual(["tool_search", "computer_read", "computer_read", "computer_insert", "tool_search", "computer_display", "computer_delete"]);
  for (const id of ["find", "guide", "session", "close", "delete"])
    expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
  expect(getToolResultText(result, "find")).toContain("computer_read");
  // tool_search loads the best matches of each query, at most 8 by default.
  for (const tool of ["computer_open", "computer_window", "computer_display", "computer_delete"]) expect(getToolResultText(result, "find")).toContain(tool);
  for (const tool of ["computer_wait", "computer_browser"]) expect(getToolResultText(result, "more")).toContain(tool);
  // A typed tool refuses a bad address with a receipt before any native work.
  expect(getToolExecution(result, "display").isError).toBe(true);
  expect(getToolResultText(result, "display")).not.toContain("unknown");
  expect(getToolResultText(result, "display")).toContain("Display addresses name their machine");
  expect(getToolResultText(result, "delete")).toContain("Computer closed");
  expect(getToolResultText(result, "guide")).toMatch(/^# Computer resources/);
  expect(getToolResultText(result, "session")).toContain("computer:machine/local");
  expect(getToolResultText(result, "close")).toContain("Computer closed");
}, 120_000);

test("an IDE that refuses this plugin API version leaves computer use standalone", async () => {
  const result = await run("incompatible-ide", ["builtin:tool-search", path.join(root, "test/fixtures/incompatible-ide-extension.ts"), computerUse], ["read"], [
    { id: "find", name: "tool_search", arguments: { query: "computer read windows displays" } },
    { id: "session", name: "computer_read", arguments: { path: "computer:session" } },
  ]);
  expect(getToolCallNames(result)).toEqual(["tool_search", "computer_read"]);
  expect(getToolExecution(result, "session").isError, getToolResultText(result, "session")).toBe(false);
  expect(getToolResultText(result, "session")).toContain("computer:machine/local");
}, 120_000);

test("with Pi Agent IDE, computer use extends Read, Search, Insert and Delete and adds only the typed computer tools", async () => {
  for (const extensions of [[ide, computerUse, "builtin:tool-search"], [computerUse, ide, "builtin:tool-search"]]) {
    const result = await run("with-ide", extensions, ["read", "insert", "delete", "tool_search"], [
      { id: "find", name: "tool_search", arguments: { query: "computer read windows displays" } },
      { id: "session", name: "read", arguments: { path: "computer:session" } },
      { id: "close", name: "insert", arguments: { path: "computer:session", text: '{"action":"close"}' } },
      { id: "force", name: "delete", arguments: { path: "computer:machine/local?force=true" } },
      { id: "delete", name: "delete", arguments: { path: "computer:session" } },
    ]);
    // The force option reaches computer use through the IDE's resolver, which then refuses it for a machine.
    expect(getToolResultText(result, "force")).toContain("?force=true applies to window addresses only.");
    expect(getToolResultText(result, "find")).not.toContain("computer_read");
    expect(getToolResultText(result, "find")).not.toContain("computer_delete");
    for (const tool of ["computer_open", "computer_window", "computer_display", "computer_wait", "computer_browser"]) expect(getToolResultText(result, "find")).toContain(tool);
    for (const id of ["session", "close", "delete"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(getToolResultText(result, "session")).toContain("computer:session");
    expect(getToolResultText(result, "close")).toContain("Computer closed");
    expect(getToolResultText(result, "delete")).toContain("Computer closed");
  }
}, 240_000);
