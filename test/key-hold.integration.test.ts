import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi admits one bounded hold, refuses an invalid pointer tail and preserves release uncertainty without replay", async () => {
  await mkdir(".tmp/key-holds", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/key-holds/pi-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log],
  }));
  // A refusal spends its observation, so each later hold acts on a fresh overview.
  const code = `${SCRIPT_HELPERS}
const opened = await openApp("Notepad");
const fresh = async () => observation(await tools.computer_read({path:opened.window}));
const send = (view, command) => insert(view, {action:"hold",delivery_mode:"foreground",...command});
if((await send(opened.observation,{keys:["shift"],duration_ms:500,actions:[{action:"click",x:20,y:30},{action:"drag",from_x:20,from_y:30,via:[{x:501,y:40}],to_x:100,to_y:30}]})).outcome !== "refused") throw Error("Invalid pointer tail admitted");
const complete = await send(await fresh(),{keys:["shift","w"],duration_ms:500,actions:[{action:"click",x:20,y:30}]});
if(complete.outcome !== "delivered" || !complete.text.includes("keys_released=true")) throw Error("Complete hold receipt lost");
const view = await fresh();
const partial = await send(view,{keys:["escape"],duration_ms:500});
if(partial.outcome !== "unknown" || !partial.text.includes("keys_released=false")) throw Error("Release uncertainty lost");
text(partial.text);
if((await send(view,{keys:["w"],duration_ms:500})).outcome !== "refused") throw Error("Uncertain hold replay admitted");
text("Bounded key hold guards passed");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "key-hold", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/held-path-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_insert"],
      conversation: [
        assistantMessage([toolCall({ id: "hold", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_insert", arguments: { path: "computer:session", text: '{"action":"close"}' } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use one bounded hold. Never replay uncertain or partially completed input.");
    expect(getToolExecution(result, "hold").isError, getToolResultText(result, "hold")).toBe(false);
    expect(getToolResultText(result, "hold")).toContain("keys_released=false");
    expect(getToolResultText(result, "hold")).toContain("Bounded key hold guards passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => ["fixture_key_hold", "press_key", "drag", "click"].includes(call.name))).toEqual([
      { name: "fixture_key_hold", arguments: {pid:42,window_id:91,delivery_mode:"foreground",keys:["shift","w"],duration_ms:500,actions:[{action:"click",x:20,y:30}]} },
      { name: "fixture_key_hold", arguments: {pid:42,window_id:91,delivery_mode:"foreground",keys:["escape"],duration_ms:500} },
    ]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
