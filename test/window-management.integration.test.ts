import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { IDE_EXTENSION, PI_COMMAND } from "./fixtures/pi-agent-ide.ts";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "test/fixtures/window-management-extension.ts");
const driver = path.join(root, "test/fixtures/window-management-driver.mjs");

// Pattern: executable real-Pi extension example and the ordinary-IDE restore suite.
// Contract: computer_window samples native desktop geometry for one command; it is never pixel/input authority.
for (const scenario of ["workflow", "admission", "receipts", "restore", "typed"] as const) test.each([false, true])(
  `ordinary IDE window management protects ${scenario} (providerFirst=%s)`,
  async providerFirst => {
    const extension = IDE_EXTENSION;
    await mkdir(path.join(root, ".tmp/lpt-731"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/lpt-731/pi-management-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [driver, path.join(cwd, "calls.jsonl")] }));
      const result = await new PiIntegrationTest({
        testName: `ide-window-management-${scenario}-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, rawMode: false,
        piCommand: PI_COMMAND,
        extensions: providerFirst ? [fixture, extension] : [extension, fixture],
        tools: ["read", "search", "write", "insert", "delete", "verify_window_management"], timeoutMs: 90_000,
        conversation: [assistantMessage([toolCall({ id: "management-proof", name: "verify_window_management", arguments: { scenario } })], { stopReason: "toolUse" }),
          assistantMessage([text("Finished the synthetic window management scenario.")])],
      }).run("Use ordinary IDE tools against the synthetic MCP window fixture only. Never operate a real desktop or use input fallback.");
      expect(result.tuiRenderedOutput, "Extension loading must succeed before evaluating behavior").not.toContain("Failed to load extension");
      expect(getToolExecution(result, "management-proof").isError, getToolResultText(result, "management-proof")).toBe(false);
      expect(getToolResultText(result, "management-proof")).toContain(`IDE window management ${scenario} contract passed`);
      const rows = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const mutations = rows.filter(row => row.name === "manage_window");
      expect(mutations).toHaveLength({ workflow: 6, admission: 1, receipts: 16, restore: 3, typed: 3 }[scenario]);
      for (const { arguments: args } of mutations) {
        const fields = args.operation === "move" ? ["x", "y", "unit"] : args.operation === "resize" ? ["width", "height", "unit"] : [];
        expect(Object.keys(args).sort()).toEqual(["pid", "window_id", "state_id", "operation", ...fields].sort());
        expect(args).toMatchObject({ pid: 42, window_id: expect.any(Number), state_id: expect.stringMatching(/^state-/) });
        if (fields.length) expect(args.unit).toBe("windows_desktop_pixels");
      }
      if (scenario === "workflow") {
        expect(mutations.map(row => row.arguments.operation)).toEqual(["move", "resize", "focus", "maximize", "minimize", "move"]);
        expect(mutations[0].arguments).toMatchObject({ x: -20, y: 120 });
        expect(mutations[1].arguments).toMatchObject({ width: 180, height: 120 });
      }
      const restores = rows.filter(row => row.name === "restore_window");
      if (scenario === "typed") expect(mutations.map(row => row.arguments.operation)).toEqual(["move", "resize", "maximize"]);
      expect(restores).toHaveLength(scenario === "restore" ? 2 : scenario === "typed" ? 1 : 0);
      for (const row of restores) expect(Object.keys(row.arguments).sort()).toEqual(["pid", "state_id", "window_id"]);
      expect(rows.filter(row => ["click", "type_text", "hotkey", "press_key", "bring_to_front", "set_window_frame", "move_pointer", "scroll_at", "get_desktop_state", "zoom"].includes(row.name))).toEqual([]);
      expect(result.tuiRenderedOutput).not.toContain("already handles");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 120_000,
);
