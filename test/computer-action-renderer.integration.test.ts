import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
// Pattern: native-TUI example plus the existing ordinary DOM action MCP fixture.
// Contract: the real Insert renderer retains a safe refusal receipt and leaves file writes alone.
test.each([false, true])("native computer refusal receipt survives IDE rendering (providerFirst=%s)", async providerFirst => {
  const ide = process.env.PI_DOM_ACTION_IDE_SOURCE ?? "/root/dev/pi/pi-agent-ide";
  const core = path.join(ide, "src/pi-agent-ide.ts"), fixture = path.join(root, "test/fixtures/dom-action-renderer-extension.ts");
  await mkdir(path.join(root, ".tmp/lpt-734"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/lpt-734/pi-computer-renderer-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [path.join(root, "test/fixtures/dom-actions-driver.mjs"), path.join(cwd, "calls.jsonl")] }));
    const result = await new PiIntegrationTest({
      testName: `computer-refusal-renderer-${providerFirst ? "provider-first" : "core-first"}`,
      artifactsDir: testArtifactsDir(import.meta.filename), cwd, isolateUserResources: true, rawMode: false,
      piCommand: process.env.PI_DOM_ACTION_PI_COMMAND ?? "/usr/bin/pi",
      extensions: providerFirst ? [fixture, core] : [core, fixture],
      tools: ["read", "search", "insert", "write", "prepare_dom_action_source"], timeoutMs: 90_000,
      conversation: [assistantMessage([toolCall({ id: "guide", name: "read", arguments: { path: "docs:editing" } })], { stopReason: "toolUse" }),
      assistantMessage([toolCall({ id: "prepare", name: "prepare_dom_action_source", arguments: {} })], { stopReason: "toolUse" }),
      assistantMessage([toolCall({ id: "refused-dom", name: "insert", arguments: {
        path: "computer:observation/renderer-fixture", text: JSON.stringify({ action: "dom", source_hint: "fixture:a", input_route: "trusted",
          request: { action: "click", locator: { test_id: "name" }, timeout_ms: 1000 } }),
      } })], { stopReason: "toolUse" }),
      assistantMessage([toolCall({ id: "ordinary-file", name: "write", arguments: { path: "ordinary.txt", content: "Unrelated file renderer stays native.\n" } })], { stopReason: "toolUse" }),
      assistantMessage([toolCall({ id: "close", name: "insert", arguments: { path: "computer:session", text: '{"action":"close"}' } })], { stopReason: "toolUse" }),
      assistantMessage([text("Finished the synthetic receipt rendering contract.")])],
    }).run("Use the synthetic MCP fixture only. Render the trusted DOM refusal and write one unrelated local file; never launch a browser or issue native input.");
    expect(getToolExecution(result, "refused-dom").isError).toBe(true);
    expect(getToolResultText(result, "refused-dom")).toContain("browser_input_trust_unavailable");
    expect(result.tuiRenderedOutput).toContain("DOM action: refused; trusted=false; atomic=false; effects=unverified");
    expect(result.tuiRenderedOutput).toContain("Attempted steps: []; acknowledged: []");
    expect(result.tuiRenderedOutput).toContain("reason=dom_action_trusted_unavailable");
    expect(result.tuiRenderedOutput).not.toContain("edit failed");
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
    expect(await readFile(path.join(cwd, "ordinary.txt"), "utf8")).toBe("Unrelated file renderer stays native.\n");
    expect(getToolExecution(result, "ordinary-file").isError).toBe(false);
    expect(result.tuiRenderedOutput).toContain("ordinary.txt");
    expect(result.tuiRenderedOutput).toContain("+1 ~0 -0");
    const calls = (await readFile(path.join(cwd, "calls.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
    expect(calls.filter(row => row.name === "browser_dom_action")).toHaveLength(1);
    expect(calls.filter(row => row.name === "end_session")).toHaveLength(1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}, 120_000);
