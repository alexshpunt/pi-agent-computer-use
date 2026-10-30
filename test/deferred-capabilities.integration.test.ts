import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { IDE_EXTENSION, PI_COMMAND } from "./fixtures/pi-agent-ide.ts";

const computer = path.resolve("src/index.ts");
const probe = path.resolve("test/fixtures/computer-capability-snapshot.ts");
type Schema = { name: string; description: string; parameters: { properties: Record<string, { description?: string }> }; promptGuidelines: string[] };
type Snapshot = { tools: Schema[]; computerTools: string[]; activeTools: string[]; entries: { data: { active: string[] } }[]; additions: Record<string, string> };
const call = (id: string, name: string, args: Record<string, unknown> = {}) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
const take = (id: string) => call(id, "computer_capability_snapshot");
const snapshot = (result: Awaited<ReturnType<PiIntegrationTest["run"]>>, id: string) =>
  JSON.parse(getToolResultText(result, id)) as Snapshot;
const active = (value: Snapshot) => value.entries.at(-1)?.data.active ?? [];
const schema = (value: Snapshot, name: string) => {
  const tool = value.tools.find(tool => tool.name === name);
  if (!tool) throw Error("Missing shared tool: " + name);
  return tool;
};

async function run(name: string, extensions: string[], conversation: ReturnType<typeof assistantMessage>[], mode = "on", excluded: string[] = [], transport: "rpc" | "tui" = "rpc") {
  await mkdir(".tmp/computer-capabilities", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/computer-capabilities/case-"));
  const agentDir = path.join(cwd, "agent");
  try {
    await mkdir(agentDir);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(path.join(cwd, ".pi/pi-agent-ide/extensions.json"), JSON.stringify({ noPostProcessing: transport !== "tui" }));
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
      defaultTools: ["+codemode", "+tool_search", ...excluded.map(name => "-" + name)],
      codemode: { mode, inlineBudget: 0 },
    }));
    await writeFile(path.join(cwd, "example.txt"), "ordinary-file-content\n");
    const started = path.join(cwd, "native-started");
    const trap = path.join(cwd, "trap-driver.mjs");
    await writeFile(trap, 'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "unexpected"); process.exit(1);\n');
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [trap, started] }));
    const result = await new PiIntegrationTest({
      testName: name, cwd, rawMode: false, transport,
      piCommand: PI_COMMAND, artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [...extensions, probe, "builtin:codemode", "builtin:tool-search"],
      environment: { PI_CODING_AGENT_DIR: agentDir },
      conversation: [...conversation, assistantMessage([text("Done")])],
    }).run("Verify computer capability activation without opening native resources");
    await expect(access(started)).rejects.toMatchObject({ code: "ENOENT" });
    return result;
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test.each([
  { computerFirst: false, discovered: "ide_capability_computer" },
  { computerFirst: true, discovered: "ide_capability_computer" },
  { computerFirst: false, discovered: "computer_window" },
])("computer discovery defers shared metadata ($discovered, computerFirst=$computerFirst)", async ({ computerFirst, discovered }) => {
  const base = snapshot(await run("computer-capability-base", [IDE_EXTENSION], [take("base")]), "base");
  const result = await run("computer-capability-discovery-" + discovered + "-" + computerFirst,
    computerFirst ? [computer, IDE_EXTENSION] : [IDE_EXTENSION, computer], [
      take("initial"),
      call("file", "read", { path: "example.txt" }), take("after-file"),
      call("miss", "tool_search", { query: "zxqv704839", limit: 1 }), take("after-miss"),
      call("discover", "tool_search", { query: discovered, limit: 1 }), take("activated"),
      call("repeat", "tool_search", { query: discovered, limit: 1 }), take("repeated"),
    ]);
  for (const id of ["initial", "after-file", "after-miss"]) {
    const value = snapshot(result, id);
    const metadata = (tools: Schema[]) => tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    expect(metadata(value.tools)).toEqual(metadata(base.tools));
    if (value.additions.search) expect(schema(value, "search").promptGuidelines).not.toContain(value.additions.search);
    expect(active(value)).not.toContain("computer");
  }
  expect(getToolExecution(result, "file").isError).toBe(false);
  expect(getToolResultText(result, "file")).toContain("ordinary-file-content");
  const activated = snapshot(result, "activated");
  const loaded = (getToolExecutionDetails(getToolExecution(result, "discover")) as { loaded: string[] }).loaded;
  expect(loaded).toHaveLength(1);
  if (discovered === "ide_capability_computer") expect(loaded).toEqual([discovered]);
  else expect(loaded[0]).not.toBe("ide_capability_computer");
  expect(activated.computerTools).toEqual(expect.arrayContaining(loaded));
  expect(active(activated)).toContain("computer");
  const repeated = snapshot(result, "repeated");
  // Native discovery can load the next matching action; the capability contribution stays unchanged.
  expect(repeated.tools).toEqual(activated.tools);
  expect(repeated.entries).toEqual(activated.entries);
  for (const [tool, field, addition] of [
    ["read", "path", "path"], ["read", "views", "views"], ["delete", "path", "delete"],
  ]) {
    expect(schema(activated, tool).parameters.properties[field].description).toContain(activated.additions[addition]);
  }
  if (activated.additions.search) expect(schema(activated, "search").promptGuidelines).toContain(activated.additions.search);
  const initialDeclarations = getCurrentTools(result.providerRequests[0]?.messages as Message[]);
  const finalDeclarations = getCurrentTools(result.providerRequests.at(-1)?.messages as Message[]);
  for (const name of ["read", "search", "delete"]) {
    const initial = initialDeclarations.find(tool => tool.name === name);
    const final = finalDeclarations.find(tool => tool.name === name);
    expect(initial?.parameters).toEqual(schema(base, name).parameters);
    expect(final?.parameters).toEqual(schema(activated, name).parameters);
  }
}, 120_000);

test.each(["on", "only"])("Codemode computer search stays inactive until its first call (%s)", async mode => {
  const result = await run("computer-capability-codemode-" + mode, [IDE_EXTENSION, computer], [
    take("initial"),
    call("describe", "codemode", { code: 'text(await searchTools("computer window")); text(await describeTool("computer_window")); text(await describeNamespace("computer"));' }),
    take("described"),
    call("first-use", "codemode", { code: 'text(await tools.computer_window({window:"computer:window/not-a-window",action:"name",as:"unused"}));' }),
    take("used"),
  ], mode);
  expect(getToolExecution(result, "describe").isError).toBe(false);
  expect(snapshot(result, "described")).toEqual(snapshot(result, "initial"));
  expect(active(snapshot(result, "used"))).toContain("computer");
}, 120_000);

test("excluding the resource loader keeps it hidden while computer actions remain usable", async () => {
  const result = await run("computer-capability-excluded-loader", [IDE_EXTENSION, computer], [
    call("catalog-before", "codemode", { code: 'if (ALL_TOOLS.some(({name}) => name === "ide_capability_computer")) throw new Error("Excluded loader is callable");' }),
    take("initial"),
    call("discover-action", "tool_search", { query: "computer_window", limit: 1 }),
    take("activated"),
    call("catalog-after", "codemode", { code: 'if (ALL_TOOLS.some(({name}) => name === "ide_capability_computer")) throw new Error("Excluded loader is callable");' }),
  ], "on", ["ide_capability_computer"]);
  for (const id of ["catalog-before", "catalog-after"]) {
    expect(getToolExecution(result, id).isError).toBe(false);
  }
  expect(active(snapshot(result, "initial"))).not.toContain("computer");
  const loaded = (getToolExecutionDetails(getToolExecution(result, "discover-action")) as { loaded: string[] }).loaded;
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).not.toBe("ide_capability_computer");
  expect(snapshot(result, "activated").computerTools).toEqual(expect.arrayContaining(loaded));
  expect(active(snapshot(result, "activated"))).toContain("computer");
}, 120_000);

test("the resource loader runs through the real Pi TUI", async () => {
  const result = await run("computer-capability-native-tui", [IDE_EXTENSION, computer], [
    call("discover", "tool_search", { query: "ide_capability_computer", limit: 1 }),
    call("load", "ide_capability_computer"),
  ], "on", [], "tui");
  expect(getToolExecution(result, "load").isError).toBe(false);
  expect(getToolExecutionDetails(getToolExecution(result, "load"))).toMatchObject({ capability: "computer" });
  expect(getToolExecutionDetails(getToolExecution(result, "discover"))).toMatchObject({ loaded: ["ide_capability_computer"] });
}, 120_000);
