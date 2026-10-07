import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

for (const mode of ["yolo", "safe"] as const) {
  test(`real Pi ${mode} exposes only permitted sampled desktop membership without input or automatic image forwarding`, async () => {
    await mkdir(".tmp/lpt-624", { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/lpt-624/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [path.resolve("test/fixtures/shell-desktop-driver.mjs"), log] }));
    const discover = `const raw=await tools.computer_windows({});
const r=JSON.parse(raw.slice(raw.indexOf("\\n{")+1));
const windows=r.state.windows;
if(windows.length!==2||new Set(windows.map(w=>w.source_identity.membership.virtual_desktop_id)).size!==2)throw Error("Distinct native desktops missing");
store("ref",windows[0].window_ref);text(windows.map(w=>w.source_identity));`;
    const observe = `const r=await tools.computer_observe({window_ref:load("ref"),capture:{hints:false}});
if(r.source.virtual_desktop.status!=="sampled"||r.source.membership.virtual_desktop_id!=="11223344-5566-7788-99aa-bbccddeeff00")throw Error("Fresh native membership missing");
if(r.source_identity.membership.virtual_desktop_id!==r.source.membership.virtual_desktop_id||r.window_ref!==load("ref"))throw Error("Membership confused with lifetime");
text(r.source.virtual_desktop);`;
    try {
      const result = await new PiIntegrationTest({ testName: `shell-desktop-${mode}`, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
        extensions: [path.resolve(mode === "safe" ? "test/fixtures/safe-extension.ts" : "test/fixtures/shell-desktop-extension.ts")],
        isolateUserResources: true, tools: mode === "safe" ? ["computer_windows", "computer_close"] : ["codemode", "computer_windows", "computer_observe", "computer_close"],
        conversation: [
          assistantMessage([toolCall({ id: "discover", name: mode === "safe" ? "computer_windows" : "codemode",
            arguments: mode === "safe" ? {} : { code: discover } })], { stopReason: "toolUse" }),
          ...(mode === "yolo" ? [assistantMessage([toolCall({ id: "observe", name: "codemode", arguments: { code: observe } })], { stopReason: "toolUse" })] : []),
          assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
          assistantMessage([text("Read-only membership contract checked.")]),
        ] }).run("Read only permitted window membership. Do not switch desktops, activate windows or send input.");
      expect(getToolExecution(result, "discover").isError).toBe(false);
      if (mode === "safe") expect(getToolExecutionDetails(getToolExecution(result, "discover"))).toMatchObject({ state: { windows: [] } });
      else {
        expect(getToolExecution(result, "observe").isError).toBe(false);
        expect(JSON.parse(getToolResultText(result, "observe").trim().split("\n").at(-1)!)).toMatchObject({ status: "sampled", on_current_desktop: false });
        for (const id of ["discover", "observe"])
          expect((getToolExecutionResult(result, id) as { content: { type: string }[] }).content.filter(b => b.type === "image")).toHaveLength(0);
      }
      const calls = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(calls.every(c => ["list_windows", "fixture_identity", "get_window_state"].includes(c.name))).toBe(true);
      expect(calls.filter(c => c.name === "list_windows")).toHaveLength(mode === "safe" ? 0 : 1);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
