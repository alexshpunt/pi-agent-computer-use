import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { getToolExecutions, PiIntegrationTest, PiRun } from "pi-coding-agent-test";
import { createCuaBrowserSite } from "../test/fixtures/cua-browser-site.mjs";

// Opt-in real-model run through the production extension, without Pi Agent IDE.
// Only browser tools on a synthetic local fixture. --from-run exports offline.
const root = process.cwd();
const recorded = process.argv[2] === "--from-run" ? process.argv[3] : undefined;
const directory = path.join(root, `.tmp/cua-pivot/model-foreground-${Date.now()}`);
await mkdir(directory, { recursive: true });
assert.ok(!process.argv[2] || recorded, "Use --from-run <run.jsonl> or no arguments.");
const site = recorded ? undefined : await createCuaBrowserSite();
let summary = { success: false };
try {
  const cwd = recorded ? undefined : await mkdtemp(path.join(root, ".tmp/cua-pivot/model-cwd-"));
  const result = recorded ? await PiRun.open(recorded) : await new PiIntegrationTest({
    testName: "native-cua-production", artifactsDir: path.join(root, ".tmp/cua-pivot/model-runs"), cwd,
    extensions: [path.join(root, "test/fixtures/native-cua-extension.ts")],
    tools: ["codemode", "browser_open", "browser_focus", "browser_observe", "browser_act", "browser_tabs", "browser_close"],
    providerMode: "user", isolateUserResources: true, rawMode: false, timeoutMs: 300_000,
  }).run(`Qualify the native CUA production browser using ONLY its browser tools and Pi Codemode.
Only synthetic URLs on ${site.url} are authorized. No shell, IDE, desktop input, personal browser, raw CDP, page JavaScript or hidden state.
Open ${site.url}; focus tab1. Ground on the returned semantic text AND native window PNG; screenshots can show an older paint, so take bounded read-only observations if needed, never replay input to refresh pixels.
Observe the hints for One, Two, Three, Four. Save one as an old hint, then in ONE Codemode script await four tools.browser_act({click:hint,observe:false}); finally observe and forward text(view.text) and image(view.image). Verify Selections:4, not just dispatched clicks.
Use Message and Submit hints from the NEW snapshot to fill exactly Pi CUA real model396 and submit in one awaited script; observe and forward actual PNG and text. Verify Submitted: Pi CUA real model396.
Make exactly ONE deliberate call with the saved retired hint; verify refusal, no input retry.
Navigate ${site.url}next, observe and forward text and PNG; verify Next local page reached.
Close the owned browser with browser_close. Report honestly, including native picture lag if present. Do not open extra tabs, type keys, change mode or use unsupported operations. Every semantic observation replaces all hints; image_only capture does not.`);
  const rows = [];
  for (const [index, execution] of getToolExecutions(result).entries()) {
    const content = execution.result?.content ?? [];
    const row = { tool: execution.toolName, callId: execution.toolCallId, isError: execution.isError,
      text: content.filter(block => block.type === "text").map(block => block.text).join("\n"),
      details: execution.result?.details === undefined ? undefined : JSON.parse(JSON.stringify(execution.result.details,
        (key, value) => ["image", "data", "base64"].includes(key) ? undefined : value)), images: [] };
    for (const [number, image] of content.filter(block => block.type === "image").entries()) {
      const filename = `${index}-${number}.${image.mimeType === "image/jpeg" ? "jpg" : "png"}`;
      await writeFile(path.join(directory, filename), Buffer.from(image.data, "base64"));
      row.images.push(filename);
    }
    rows.push(row);
  }
  summary = { success: false, model: result.state.model, rows, artifacts: result.artifacts,
    visualVerification: "Manual PNG inspection is required. Semantic text plus an image block is not pixel agreement." };
  assert.ok(rows.some(row => row.tool === "codemode" && row.text.includes("Selections: 4") && row.images.length));
  assert.ok(rows.some(row => row.text.includes("Submitted: Pi CUA real model396") && row.images.length));
  assert.ok(rows.some(row => row.isError && row.text.includes("refused")));
  assert.ok(rows.some(row => row.text.includes("Next local page reached") && row.images.length));
  assert.ok(rows.some(row => row.tool === "browser_close" && !row.isError && row.text.includes("released")));
  summary.success = true;
} finally {
  await site?.close();
  await writeFile(path.join(directory, "run.json"), JSON.stringify(summary, null, 2) + "\n");
}
console.log(JSON.stringify({ success: summary.success, executions: summary.rows?.length, directory }));
