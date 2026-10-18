import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "test/fixtures/dom-native-detail-extension.ts");
const driver = path.join(root, "test/fixtures/dom-native-detail-driver.mjs");

// Pattern: executable extension example and existing ordinary-IDE readonly DOM tests.
// Contract: real loader/provider/MCP/wrapper delivery preserves readonly crop pixels and withholds changed-source pixels.
for (const scenario of ["workflow", "refusal"] as const) test.each([false, true])(
  `ordinary IDE native DOM detail protects ${scenario} (providerFirst=%s)`, async providerFirst => {
    const ide = process.env.PI_DOM_DETAIL_IDE_SOURCE ?? "/root/dev/pi/pi-agent-ide";
    const extension = path.join(ide, "src/pi-agent-ide.ts");
    await mkdir(path.join(root, ".tmp/lpt-733"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/lpt-733/pi-native-detail-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [driver, path.join(cwd, "calls.jsonl")] }));
      const result = await new PiIntegrationTest({
        testName: `ide-native-dom-detail-${scenario}-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, rawMode: false,
        piCommand: process.env.PI_DOM_DETAIL_PI_COMMAND ?? "/usr/bin/pi",
        extensions: providerFirst ? [fixture, extension] : [extension, fixture],
        tools: ["read", "search", "write", "insert", "verify_dom_native_detail"], timeoutMs: 90_000,
        conversation: [assistantMessage([toolCall({ id: "native-detail-proof", name: "verify_dom_native_detail", arguments: { scenario } })], { stopReason: "toolUse" }),
          assistantMessage([text("Finished the synthetic native DOM detail contract.")])],
      }).run("Use ordinary IDE resources against the synthetic MCP peer only. Do not launch applications, call a native capture or dispatch real input.");
      expect(result.tuiRenderedOutput, "Fixture extensions must load before checking detail behavior").not.toContain("Failed to load extension");
      expect(getToolExecution(result, "native-detail-proof").isError, getToolResultText(result, "native-detail-proof")).toBe(false);
      expect(getToolResultText(result, "native-detail-proof")).toContain(`IDE native DOM detail ${scenario} contract passed`);
      const rows = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const geometry = rows.filter(row => row.arguments.native_geometry_ref !== undefined), crops = rows.filter(row => row.name === "zoom");
      const snapshots = rows.filter(row => row.name === "get_browser_state" && row.arguments.snapshot_format && !row.arguments.native_geometry_ref);
      expect(geometry).toHaveLength(scenario === "workflow" ? 6 : 3);
      expect(crops).toHaveLength(scenario === "workflow" ? 2 : 1);
      expect(snapshots).toHaveLength(scenario === "workflow" ? 1 : 2);
      expect(rows.filter(row => row.name === "get_browser_state" && !row.arguments.snapshot_format)).toHaveLength(1);
      for (const { arguments: args } of geometry) {
        expect(args).toEqual({ target_id: "bt-private-detail", tab_id: "tab-private-detail", session: expect.any(String),
          snapshot_format: "dom_inspect_v1", native_geometry_ref: scenario === "workflow" ? "p1:0" : "p2:0" });
      }
      for (const { arguments: args } of crops) expect(args).toEqual({ pid: 42, window_id: 91, session: expect.any(String), capture_backend: "wgc", x1: 86, y1: 221, x2: 105, y2: 237 });
      const transaction = rows.filter(row => row.arguments.native_geometry_ref !== undefined || row.name === "zoom").map(row => row.name);
      expect(transaction).toEqual(Array(scenario === "workflow" ? 2 : 1).fill(["get_browser_state", "get_browser_state", "zoom", "get_browser_state"]).flat());
      expect(rows.filter(row => ["click", "type_text", "hotkey", "press_key", "browser_dom_action", "browser_prepare", "browser_navigate", "get_window_state", "get_desktop_state"].includes(row.name))).toEqual([]);
      expect(rows.filter(row => row.name === "start_session")).toHaveLength(1);
      expect(rows.filter(row => row.name === "end_session")).toHaveLength(1);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 120_000,
);
