import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolCallNames, getToolExecutionDetails, getToolExecutionResult, getToolExecutions, PiIntegrationTest, PiRun } from "pi-coding-agent-test";
import { startBrowserFixture } from "../test/fixtures/browser-site.mjs";
import { browserNativeState } from "./browser-native-state.mjs";

// Opt-in real-model Pi qualification. Only owned browser tools and Pi Codemode on synthetic local pages.
const root = process.cwd();
await mkdir(".tmp", { recursive: true });
const cwd = await mkdtemp(path.join(root, ".tmp/native-browser-"));
const directory = path.join(root, ".tmp/browser-model");
await mkdir(directory, { recursive: true });
const fixture = await startBrowserFixture();
const recorded = process.argv[2] === "--from-run" ? process.argv[3] : undefined;
if (process.argv[2] && !recorded) throw new Error("Use --from-run <run.jsonl> or no arguments.");
let success = false;
let summary = {};
try {
  const result = recorded ? await PiRun.open(recorded) : await new PiIntegrationTest({
    testName: "native-focused-browser", artifactsDir: path.join(root, ".tmp/native-runs"), cwd,
    extensions: [path.join(root, "test/fixtures/native-browser-extension.ts")],
    tools: ["codemode", "browser_open", "browser_focus", "browser_observe", "browser_act", "browser_tabs", "browser_close"],
    providerMode: "user", isolateUserResources: true, rawMode: false, timeoutMs: 300_000,
  }).run(`Qualify the focused visible browser using ONLY these browser tools and existing Pi Codemode.
Use only synthetic URLs on ${fixture.url}; no site code, hidden state, shell, IDE, desktop input or personal browsers.
1. Open ${fixture.url}/focus. Verify text and labelled screenshot. Select tab 1 once with browser_focus.
2. Use the four observed hints for One, Two, Three, Four in ONE Codemode script: sequential tools.browser_act({click:hint}) for each, then const view = await tools.browser_observe({}); text(view.text); image(view.image).
Actions return compact input outcomes, NOT screenshots by default. Final observation must show Selections: 4 and the real labelled PNG.
3. Fill Message with exactly Pi focused browser and click Submit message using hints from the SAME current observation in one Codemode script, then observe and forward view.text and image(view.image). Verify Confirmed: Pi focused browser.
4. Open ${fixture.url}/form in a second owned tab. Check both storage/cookie markers absent. Fill Message exactly Pi visible browser, submit, observe and verify confirmation and storage/cookie markers present.
5. Use browser_focus({tab:1}) to return to the first tab. Verify Selections: 4 and the earlier focused confirmation still present.
6. Make ONE deliberate browser_act({click:"neverallocated"}) and verify refusal. Never replay unknown input.
7. Close the whole owned browser. Open ${fixture.url}/form again and verify both storage/cookie markers absent. Close again.
No repeated page/observation IDs. Newly observed short hints replace earlier labels; do not use retired hints. No automatic readiness promise: use bounded wait_ms where needed, then fresh observation. Report honest results.`);
  const executions = getToolExecutions(result);
  const rows = executions.map(execution => ({ tool: execution.toolName, callId: execution.toolCallId,
    details: getToolExecutionDetails(execution), isError: execution.isError, text: (execution.result?.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n") }));
  assert.ok(rows.some(row => row.tool === "codemode" && row.text.includes("Selections: 4")), "Four-click Codemode sequence was not verified.");
  assert.ok(rows.some(row => row.text.includes("Confirmed: Pi focused browser")));
  assert.ok(rows.some(row => row.text.includes("Confirmed: Pi visible browser")));
  assert.ok(rows.some(row => row.isError && row.text.includes("refused")));
  const closes = rows.filter(row => row.tool === "browser_close" && row.details?.status === "closed");
  assert.ok(closes.length >= 2);
  const firstClose = rows.indexOf(closes[0]);
  assert.ok(rows.slice(firstClose + 1).some(row => row.text.includes("Storage marker: absent; Cookie marker: absent")), "Reopened profile was not checked.");
  for (const [index, row] of rows.entries()) {
    const images = getToolExecutionResult(result, row.callId).content.filter(block => block.type === "image");
    row.images = [];
    for (const [number, image] of images.entries()) {
      const name = index + "-" + number + ".png";
      await writeFile(path.join(directory, name), Buffer.from(image.data, "base64")); row.images.push(name);
    }
  }
  success = true;
  summary = { model: result.state.model, toolNames: getToolCallNames(result), rows, artifacts: result.artifacts };
} finally {
  await fixture.close();
  const cleanup = await browserNativeState();
  assert.equal(cleanup.browserCount, 0); assert.equal(cleanup.workerCount, 0); assert.equal(cleanup.profiles.length, 0);
  await writeFile(path.join(directory, "run.json"), JSON.stringify({ success, ...summary, cleanup }, null, 2) + "\n");
}
console.log(JSON.stringify({ success, tools: summary.toolNames?.length, directory }));
