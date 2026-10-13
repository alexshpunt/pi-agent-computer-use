import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "test/fixtures/window-restore-extension.ts");
const driver = path.join(root, "test/fixtures/window-restore-driver.mjs");

// Pattern: real-Pi extension example + ordinary IDE provider cases.
// Contract: state resources grant one restore, no pixel/input authority, and preserve interrupted native prefixes.
for (const scenario of ["workflow", "admission"] as const) test.each([false, true])(
  `ordinary IDE metadata-only restore protects ${scenario} (providerFirst=%s)`,
  async providerFirst => {
    const ide = process.env.PI_RESTORE_IDE_SOURCE ?? "/root/dev/pi/pi-agent-ide";
    const extension = path.join(ide, "src/pi-agent-ide.ts");
    await mkdir(path.join(root, ".tmp/lpt-703"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/lpt-703/pi-restore-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [driver, path.join(cwd, "calls.jsonl")] }));
      const result = await new PiIntegrationTest({
        testName: `ide-window-restore-${scenario}-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, rawMode: false,
        piCommand: process.env.PI_RESTORE_PI_COMMAND ?? "/usr/bin/pi",
        extensions: providerFirst ? [fixture, extension] : [extension, fixture],
        tools: ["read", "search", "write", "insert", "verify_window_restore"], timeoutMs: 90_000,
        conversation: [assistantMessage([toolCall({ id: "restore-proof", name: "verify_window_restore", arguments: { scenario } })], { stopReason: "toolUse" }),
          assistantMessage([text("Finished the synthetic window restore scenario.")])],
      }).run("Use ordinary IDE tools against the synthetic native window fixture. Never activate real windows or use keyboard/pointer fallback.");
      expect(getToolExecution(result, "restore-proof").isError, getToolResultText(result, "restore-proof")).toBe(false);
      expect(getToolResultText(result, "restore-proof")).toContain(`IDE window restore ${scenario} contract passed`);
      const rows = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const restores = rows.filter(row => row.name === "restore_window");
      expect(restores).toHaveLength(scenario === "workflow" ? 1 : 9);
      for (const row of restores) {
        expect(row.arguments).toEqual({ pid: 42, window_id: expect.any(Number), state_id: expect.stringMatching(/^state-/) });
        expect(Object.keys(row.arguments).sort()).toEqual(["pid", "state_id", "window_id"]);
      }
      expect(rows.filter(row => ["click", "type_text", "hotkey", "press_key", "bring_to_front", "move_pointer", "scroll_at", "get_desktop_state", "zoom"].includes(row.name))).toEqual([]);
      expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
      expect(result.tuiRenderedOutput).not.toContain("already handles");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 120_000,
);
