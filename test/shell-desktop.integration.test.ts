import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolExecutions, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

type Membership = { membership: { virtual_desktop_id: string } };

for (const mode of ["yolo", "safe"] as const) {
  test(`real Pi ${mode} exposes only permitted sampled desktop membership without input or automatic image forwarding`, async () => {
    await mkdir(".tmp/lpt-624", { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/lpt-624/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [path.resolve("test/fixtures/shell-desktop-driver.mjs"), log] }));
    const discover = `${SCRIPT_HELPERS}
const listed=await windows();
const refs=[...listed.matchAll(/computer:[\\w-]+\\/w\\d+[a-z]{2}/g)].map(match=>match[0]);
if(refs.length!==2)throw Error("Both windows missing");
store("ref",refs[0]);text(listed);`;
    const observe = `const r=await tools.computer_read({path:load("ref"),views:['capture:{"hints":false}']});
if(typeof r==="string"||!r.note.includes("Window: "+load("ref")))throw Error("Observation lost its window");
text("observed");`;
    try {
      const result = await new PiIntegrationTest({ testName: `shell-desktop-${mode}`, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
        extensions: [path.resolve(mode === "safe" ? "test/fixtures/safe-extension.ts" : "test/fixtures/shell-desktop-extension.ts")],
        isolateUserResources: true, tools: mode === "safe" ? ["computer_search", "computer_insert"] : ["codemode", "computer_insert"],
        conversation: [
          assistantMessage([toolCall({ id: "discover", name: mode === "safe" ? "computer_search" : "codemode",
            arguments: mode === "safe" ? { path: "computer:machine/local/windows", query: "" } : { code: discover } })], { stopReason: "toolUse" }),
          ...(mode === "yolo" ? [assistantMessage([toolCall({ id: "observe", name: "codemode", arguments: { code: observe } })], { stopReason: "toolUse" })] : []),
          assistantMessage([toolCall({ id: "close", name: "computer_insert", arguments: { path: "computer:session", text: '{"action":"close"}' } })], { stopReason: "toolUse" }),
          assistantMessage([text("Read-only membership contract checked.")]),
        ] }).run("Read only permitted window membership. Do not switch desktops, activate windows or send input.");
      expect(getToolExecution(result, "discover").isError, getToolResultText(result, "discover")).toBe(false);
      if (mode === "safe") expect(getToolExecutionDetails(getToolExecution(result, "discover"))).toMatchObject({ state: { windows: [] } });
      else {
        expect(getToolExecution(result, "observe").isError, getToolResultText(result, "observe")).toBe(false);
        const [listed] = nestedCalls(getToolExecutions(result), "discover");
        const rows = listed.computer.state.windows as ({ window_ref: string; source_identity: Membership })[];
        expect(new Set(rows.map(row => row.source_identity.membership.virtual_desktop_id)).size).toBe(2);
        const [read] = nestedCalls(getToolExecutions(result), "observe");
        expect(read.computer.source.virtual_desktop).toMatchObject({ status: "sampled", on_current_desktop: false });
        expect(read.computer.source.membership.virtual_desktop_id).toBe("11223344-5566-7788-99aa-bbccddeeff00");
        expect(read.computer.source_identity.membership.virtual_desktop_id).toBe(read.computer.source.membership.virtual_desktop_id);
        expect(read.computer.window_ref).toBe(rows[0].window_ref);
        for (const id of ["discover", "observe"])
          expect((getToolExecutionResult(result, id) as { content: { type: string }[] }).content.filter(b => b.type === "image")).toHaveLength(0);
      }
      const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(calls.every(c => ["list_windows", "fixture_identity", "get_window_state"].includes(c.name))).toBe(true);
      expect(calls.filter(c => c.name === "list_windows")).toHaveLength(mode === "safe" ? 0 : 1);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
