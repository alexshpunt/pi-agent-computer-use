import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "test/fixtures/dom-actions-extension.ts");
const driver = path.join(root, "test/fixtures/dom-actions-driver.mjs");

// Pattern: executable extension example plus ordinary-IDE DOM inspection fixtures.
// Contract: the real loader, semantic Insert, CodeMode, wrapper and MCP preserve explicit intent and uncertainty.
for (const scenario of ["workflow", "admission", "codemode"] as const) test.each([false, true])(
  `ordinary IDE DOM actions protect ${scenario} (providerFirst=%s)`, async providerFirst => {
    const ide = process.env.PI_DOM_ACTION_IDE_SOURCE ?? "/root/dev/pi/pi-agent-ide";
    const extension = path.join(ide, "src/pi-agent-ide.ts");
    await mkdir(path.join(root, ".tmp/lpt-734"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/lpt-734/pi-dom-actions-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath, args: [driver, path.join(cwd, "calls.jsonl")] }));
      const result = await new PiIntegrationTest({
        testName: `ide-dom-actions-${scenario}-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, rawMode: false,
        piCommand: process.env.PI_DOM_ACTION_PI_COMMAND ?? "/usr/bin/pi",
        extensions: providerFirst ? [fixture, extension] : [extension, fixture],
        tools: ["read", "search", "write", "insert", "codemode", "verify_dom_actions", "prepare_dom_action_source"], timeoutMs: 90_000,
        conversation: [assistantMessage([toolCall({ id: "dom-proof", name: scenario === "codemode" ? "codemode" : "verify_dom_actions",
          arguments: scenario === "codemode" ? { code: `const raw = await tools.prepare_dom_action_source({});
const source = JSON.parse(raw.slice(raw.indexOf("{")).split("\\n")[0]);
const input = {path:source.path,text:JSON.stringify({action:"dom",source_hint:source.hint,input_route:"dom_event",request:{action:"click",locator:{test_id:"name"},timeout_ms:1000}})};
const receipt = await tools.insert(input);
if(!receipt.includes("DOM action: dispatched") || !receipt.includes('acknowledged: ["click"]') || !receipt.includes("effects=unverified")) throw Error("CodeMode lost the native dispatch receipt or its uncertainty: " + receipt);
let retired; try { retired = await tools.insert(input); } catch (error) { retired = String(error); }
if(!retired.includes("expired")) throw Error("CodeMode replayed or renewed its consumed DOM observation");
await tools.insert({path:"computer:session",text:'{"action":"close"}'});
text("IDE DOM actions codemode contract passed");` } : { scenario } })], { stopReason: "toolUse" }),
          assistantMessage([text("Finished the synthetic locator-action contract.")])],
      }).run("Use ordinary IDE Read/Insert and CodeMode against the synthetic MCP fixture only. Never launch a real browser, capture a desktop or dispatch coordinate input.");
      expect(result.tuiRenderedOutput, "Fixture extensions must load before checking action behavior").not.toContain("Failed to load extension");
      expect(getToolExecution(result, "dom-proof").isError, getToolResultText(result, "dom-proof")).toBe(false);
      expect(getToolResultText(result, "dom-proof")).toContain(`IDE DOM actions ${scenario} contract passed`);
      const rows = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const actions = rows.filter(row => row.name === "browser_dom_action");
      expect(actions).toHaveLength(scenario === "workflow" ? 5 : 1);
      for (const { arguments: args } of actions) {
        expect(Object.keys(args).sort()).toEqual(["session", "target_id", "tab_id", "source_ref", "input_route", "request"].sort());
        expect(args).toMatchObject({ session: expect.any(String), target_id: "bt-action", tab_id: "tab-action", source_ref: expect.stringMatching(/^p[0-9]+:0$/) });
        expect(args.request.locator).toEqual({ test_id: "name" });
      }
      expect(actions.map(row => row.arguments.input_route)).toEqual(scenario === "admission" ? ["trusted"] : Array(scenario === "workflow" ? 5 : 1).fill("dom_event"));
      if (scenario === "workflow") {
        expect(actions.map(row => row.arguments.request.action)).toEqual(["fill", "click", "double_click", "click", "click"]);
        expect(actions[0].arguments.request.text).toBe("private typed value");
      }
      expect(rows.filter(row => ["click", "type_text", "hotkey", "press_key", "move_pointer", "scroll_at", "browser_click", "browser_type", "browser_prepare", "get_window_state", "get_desktop_state"].includes(row.name))).toEqual([]);
      expect(rows.filter(row => row.name === "start_session")).toHaveLength(1);
      expect(rows.filter(row => row.name === "end_session")).toHaveLength(1);
      expect(result.tuiRenderedOutput).not.toContain("already handles");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  }, 120_000,
);
