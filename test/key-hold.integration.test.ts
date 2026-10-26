import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi holds keys for a bounded time and preserves release uncertainty", async () => {
  await mkdir(".tmp/key-holds", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/key-holds/pi-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log],
  }));
  const code = `${SCRIPT_HELPERS}
const opened = await openApp("Notepad");
const press = command => tools.computer_press({window:opened.window,hold_ms:500,...command});
const complete = await press({key:"shift+w"});
if(complete.outcome !== "delivered" || !complete.text.includes("keys_released=true")) throw Error("Complete hold receipt lost: " + complete.text);
const partial = await press({key:"escape"});
if(partial.outcome !== "unknown" || !partial.text.includes("keys_released=false")) throw Error("Release uncertainty lost: " + partial.text);
text(partial.text);
text("Bounded key hold guards passed");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "key-hold", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/held-path-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [
        assistantMessage([toolCall({ id: "hold", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use one bounded hold. Never replay uncertain or partially completed input.");
    expect(getToolExecution(result, "hold").isError, getToolResultText(result, "hold")).toBe(false);
    expect(getToolResultText(result, "hold")).toContain("keys_released=false");
    expect(getToolResultText(result, "hold")).toContain("Bounded key hold guards passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => ["fixture_key_hold", "press_key", "drag", "click"].includes(call.name))).toEqual([
      { name: "fixture_key_hold", arguments: {pid:42,window_id:91,delivery_mode:"foreground",keys:["shift","w"],duration_ms:500} },
      { name: "fixture_key_hold", arguments: {pid:42,window_id:91,delivery_mode:"foreground",keys:["escape"],duration_ms:500} },
    ]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
