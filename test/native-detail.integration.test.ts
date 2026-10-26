import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutionResult, getToolResultText,
  PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { DEFAULT_MAX_LONG_EDGE } from "../src/cua-image-settings.ts";
import { SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi forwards only final display crop and window JPEG, and disarms overview input", async () => {
  await mkdir(".tmp/native-zoom", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/native-zoom/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/detail-driver.mjs"), log],
  }));
  const code = `${SCRIPT_HELPERS}
const opened = await openApp("Notepad");
if (opened.outcome !== "observed" || !opened.observation) throw Error("Open returned no first observation");
const region = "region:100,80,100,80";
const detail = await tools.computer_read({path:opened.observation,views:[region]});
text(body(detail)); image(detail);
const ref = hints(opened)[0];
if (!ref) throw Error("Open listed no refs: " + body(opened));
const stale = await tools.computer_click({window:opened.window,target:ref});
if (stale.outcome !== "refused" || stale.effect !== "not-applied") throw Error("Old overview still armed");
const overview = await tools.computer_read({path:"computer:machine/local/display/primary"});
const crop = await tools.computer_read({path:observation(overview),views:[region]});
text(body(crop)); image(crop);
let nested = "admitted";
try { await tools.computer_read({path:observation(overview),views:[region]}); } catch (error) { nested = String(error.message); }
if (!/expired/.test(nested)) throw Error("Consumed overview reused: " + nested);
text("Read-only detail guards passed");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "native-detail", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [
        assistantMessage([toolCall({ id: "detail", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Read details only. Never dispatch input from the old overview or publish intermediate full-display pixels.");
    expect(getToolExecution(result, "detail").isError, getToolResultText(result, "detail")).toBe(false);
    const answer = getToolExecutionResult(result, "detail") as { content: { type: string; mimeType?: string }[] };
    expect(answer.content.filter(b => b.type === "image").map(b => b.mimeType)).toEqual(["image/jpeg", "image/png"]);
    expect(getToolResultText(result, "detail")).toContain("Read-only detail guards passed");
    expect(getToolResultText(result, "detail")).not.toContain("PRIVATE_NATIVE_DISPLAY");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "zoom")).toHaveLength(1);
    expect(calls.filter(c => c.name === "get_desktop_state").map(c => c.arguments)).toEqual([{max_image_dimension:DEFAULT_MAX_LONG_EDGE},{max_image_dimension:0}]);
    expect(calls.some(c => ["click", "bring_to_front"].includes(c.name))).toBe(false);
  } finally { await rm(cwd, {recursive:true,force:true}); }
});
