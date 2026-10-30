import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { IDE_EXTENSION, PI_COMMAND } from "./fixtures/pi-agent-ide.ts";

const computer = path.resolve("src/index.ts");
const probe = path.resolve("test/fixtures/computer-capability-fallback.ts");
const fallbackNames = ["computer_read", "computer_search", "computer_delete"];
type Schema = {
  name: string; exposure?: string; namespace?: { name: string }; promptGuidelines?: string[];
  parameters: { required?: string[]; additionalProperties?: boolean; properties: Record<string, { type?: string; minimum?: number; description?: string }> };
};
type Snapshot = {
  tools: Schema[]; active: string[]; entries: { data: { active: string[] } }[];
  additions: Record<string, string>;
};
const call = (id: string, name: string, args: Record<string, unknown> = {}) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
const take = (id: string) => call(id, "computer_fallback_snapshot");
const snapshot = (result: Awaited<ReturnType<PiIntegrationTest["run"]>>, id: string) =>
  JSON.parse(getToolResultText(result, id)) as Snapshot;
const schema = (value: Snapshot, name: string) => value.tools.find(tool => tool.name === name);
const active = (value: Snapshot) => value.entries.at(-1)?.data.active ?? [];
const discovery = (id: string, name: string) => call(id, "tool_search", { query: name, limit: 1 });

async function run(name: string, withIde: boolean, disabled: string[], conversation: ReturnType<typeof assistantMessage>[]) {
  await mkdir(".tmp/computer-capabilities", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/computer-capabilities/fallback-"));
  const agentDir = path.join(cwd, "agent");
  const started = path.join(cwd, "native-started");
  try {
    await mkdir(agentDir);
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["+tool_search"] }));
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(path.join(cwd, ".pi/pi-agent-ide/extensions.json"), JSON.stringify({ disabled, noPostProcessing: true }));
    const trap = path.join(cwd, "trap-driver.mjs");
    await writeFile(trap, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "unexpected"); process.exit(1);\n');
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [trap, started] }));
    const result = await new PiIntegrationTest({
      testName: name, cwd, rawMode: false, transport: "rpc",
      piCommand: PI_COMMAND, artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [...(withIde ? [IDE_EXTENSION] : []), computer, probe, "builtin:tool-search"],
      environment: { PI_CODING_AGENT_DIR: agentDir },
      conversation: [...conversation, assistantMessage([text("Done")])],
    }).run("Verify standalone and partial IDE computer contracts without starting native resources");
    await expect(access(started)).rejects.toMatchObject({ code: "ENOENT" });
    return result;
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

function assertFallbackDeclarations(value: Snapshot) {
  for (const name of fallbackNames) {
    const tool = schema(value, name);
    expect(tool).toMatchObject({ exposure: "deferred", namespace: { name: "computer" }, parameters: { additionalProperties: false } });
  }
  expect(schema(value, "computer_read")?.parameters.required).toEqual(["path"]);
  expect(schema(value, "computer_search")?.parameters.required).toEqual(["path", "query"]);
  expect(schema(value, "computer_delete")?.parameters.required).toEqual(["path"]);
  expect(schema(value, "computer_read")?.parameters.properties.limit).toMatchObject({ type: "integer", minimum: 0 });
  expect(schema(value, "computer_search")?.parameters.properties.limit).toMatchObject({ type: "integer", minimum: 1 });
  expect(schema(value, "computer_read")?.parameters.properties.path.description).toContain(value.additions.standalonePath);
  expect(schema(value, "computer_read")?.parameters.properties.views.description).toBe(value.additions.standaloneViews);
  expect(schema(value, "computer_search")?.parameters.properties.path.description).toBe(value.additions.search);
  expect(schema(value, "computer_delete")?.parameters.properties.path.description).toBe(value.additions.delete);
}

test.each([false, true])("standalone resource tools keep deferred contracts and validate before native access (IDE host=%s)", async withIde => {
  const result = await run("computer-capability-standalone-" + withIde, withIde, withIde ? ["read.core", "search.core", "editor.core"] : [], [
    take("initial"),
    call("enable-fallback", "computer_fallback_snapshot", { enableFallback: true }),
    call("guide", "computer_read", { path: "docs:computer", offset: 1, limit: 1 }),
    call("invalid-read", "computer_read", { path: "docs:computer", limit: -1 }),
    call("invalid-search", "computer_search", { path: "computer:machine/local/apps" }),
    call("close", "computer_delete", { path: "computer:session" }),
    take("after"),
  ]);
  const initial = snapshot(result, "initial");
  assertFallbackDeclarations(initial);
  for (const name of fallbackNames) expect(initial.active).not.toContain(name);
  expect(schema(initial, "ide_capability_computer")).toBeUndefined();
  expect(active(initial)).not.toContain("computer");
  const after = snapshot(result, "after");
  assertFallbackDeclarations(after);
  for (const name of fallbackNames) expect(after.active).toContain(name);
  expect(schema(after, "ide_capability_computer")).toBeUndefined();
  const guide = await readFile(path.resolve("docs/computer-resources.md"), "utf8");
  expect(getToolResultText(result, "guide").split("\n")[0]).toBe(guide.split("\n")[0]);
  expect(getToolExecution(result, "guide").isError).toBe(false);
  expect(getToolExecutionDetails(getToolExecution(result, "guide"))).toMatchObject({ source: "docs:computer", startLine: 1, endLine: 1 });
  expect(getToolExecution(result, "invalid-read").isError).toBe(true);
  expect(getToolExecution(result, "invalid-search").isError).toBe(true);
  expect(getToolExecution(result, "close").isError).toBe(false);
  expect(getToolExecutionDetails(getToolExecution(result, "close"))).toMatchObject({ metadata: { semanticAction: { ok: true, effect: "applied" } } });
}, 120_000);

test.each([
  { disabled: "read.core", accepted: ["search", "delete"], rejected: "read" },
  { disabled: "search.core", accepted: ["read", "delete"], rejected: "search" },
  { disabled: "editor.core", accepted: ["read", "search"], rejected: "delete" },
])("partial IDE keeps only accepted resource metadata deferred ($disabled disabled)", async ({ disabled, accepted, rejected }) => {
  const result = await run("computer-capability-partial-" + disabled, true, [disabled], [
    take("initial"),
    discovery("load", "ide_capability_computer"),
    take("activated"),
    call("enable-fallback", "computer_fallback_snapshot", { enableFallback: true }),
    call("guide", "computer_read", { path: "docs:computer", offset: 1, limit: 1 }),
    take("after-fallback"),
  ]);
  const initial = snapshot(result, "initial");
  assertFallbackDeclarations(initial);
  expect(active(initial)).not.toContain("computer");
  for (const name of fallbackNames) expect(initial.active).not.toContain(name);
  expect(schema(initial, "ide_capability_computer")?.exposure).toBe("deferred");
  const activated = snapshot(result, "activated");
  expect(active(activated)).toContain("computer");
  expect(schema(activated, rejected)).toEqual(schema(initial, rejected));
  if (accepted.includes("read")) {
    for (const field of ["path", "views"]) {
      if (initial.additions[field]) expect(schema(initial, "read")?.parameters.properties[field].description).not.toContain(initial.additions[field]);
      expect(schema(activated, "read")?.parameters.properties[field].description).toContain(activated.additions[field]);
    }
  }
  if (accepted.includes("search")) {
    expect(schema(initial, "search")?.promptGuidelines ?? []).not.toContain(initial.additions.search);
    if (activated.additions.search) expect(schema(activated, "search")?.promptGuidelines).toContain(activated.additions.search);
  }
  if (accepted.includes("delete")) {
    if (initial.additions.delete) expect(schema(initial, "delete")?.parameters.properties.path.description).not.toContain(initial.additions.delete);
    expect(schema(activated, "delete")?.parameters.properties.path.description).toContain(activated.additions.delete);
  }
  assertFallbackDeclarations(snapshot(result, "after-fallback"));
  expect(getToolExecution(result, "guide").isError).toBe(false);
  expect(getToolExecutionDetails(getToolExecution(result, "guide"))).toMatchObject({ source: "docs:computer", startLine: 1, endLine: 1 });
}, 120_000);
