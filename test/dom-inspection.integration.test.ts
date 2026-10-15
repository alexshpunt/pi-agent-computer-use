import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "test/fixtures/dom-inspection-extension.ts");
const driver = path.join(root, "test/fixtures/dom-inspection-driver.mjs");

// Pattern: the executable extension example and ordinary-IDE management suite.
// Contract: readonly native DOM crosses the real loader/provider/IDE boundary without granting input authority.
for (const scenario of ["workflow", "admission", "receipts"] as const) test.each([false, true])(
  `ordinary IDE readonly DOM protects ${scenario} (providerFirst=%s)`, async providerFirst => {
    const ide = process.env.PI_DOM_INSPECTION_IDE_SOURCE ?? "/root/dev/pi/pi-agent-ide";
    const extension = path.join(ide, "src/pi-agent-ide.ts");
    await mkdir(path.join(root, ".tmp/lpt-733"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/lpt-733/pi-dom-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [driver, path.join(cwd, "calls.jsonl")] }));
      const result = await new PiIntegrationTest({
        testName: `ide-readonly-dom-${scenario}-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, rawMode: false,
        piCommand: process.env.PI_DOM_INSPECTION_PI_COMMAND ?? "/usr/bin/pi",
        extensions: providerFirst ? [fixture, extension] : [extension, fixture],
        tools: ["read", "search", "write", "insert", "verify_dom_inspection"], timeoutMs: 90_000,
        conversation: [assistantMessage([toolCall({ id: "dom-proof", name: "verify_dom_inspection", arguments: { scenario } })], { stopReason: "toolUse" }),
          assistantMessage([text("Finished the synthetic readonly DOM scenario.")])],
      }).run("Use ordinary IDE Read/Search against the synthetic MCP DOM fixture only. Never operate a real desktop, launch a browser or use input fallback.");
      expect(result.tuiRenderedOutput, "Extension loading must succeed before evaluating DOM behavior").not.toContain("Failed to load extension");
      expect(getToolExecution(result, "dom-proof").isError, getToolResultText(result, "dom-proof")).toBe(false);
      expect(getToolResultText(result, "dom-proof")).toContain(`IDE readonly DOM ${scenario} contract passed`);
      const rows = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const snapshots = rows.filter(row => row.name === "get_browser_state" && row.arguments.snapshot_format);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const { arguments: args } of snapshots) {
        expect(args).toMatchObject({ target_id: expect.stringMatching(/^bt-9[123]$/), tab_id: expect.stringMatching(/^tab-9[123]$/),
          snapshot_format: "dom_inspect_v1", include_screenshot: false, session: expect.any(String) });
        expect(Object.keys(args).every(key => ["target_id", "tab_id", "snapshot_format", "include_screenshot", "session", "include_hidden", "max_nodes", "max_depth", "locator", "scope_ref"].includes(key))).toBe(true);
      }
      expect(rows.filter(row => ["browser_prepare", "browser_navigate", "browser_click", "browser_type", "click", "type_text", "hotkey", "press_key", "bring_to_front", "set_window_frame", "move_pointer", "scroll_at", "get_desktop_state", "zoom"].includes(row.name))).toEqual([]);
      expect(rows.filter(row => row.name === "start_session")).toHaveLength(1);
      expect(rows.filter(row => row.name === "end_session")).toHaveLength(1);
      expect(result.tuiRenderedOutput).not.toContain("already handles");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 120_000,
);
