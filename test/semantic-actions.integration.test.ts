import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

// Protects the real Pi schema/Codemode/session/MCP boundary, not Windows application effects.
test("real Pi dispatches explicit UIA intents once and keeps provider uncertainty without a physical fallback", async () => {
  await mkdir(".tmp/lpt-626", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-626/pi-semantic-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log, "semantic"] }));
  // The peer names its semantic control with the fixed native token "field".
  const code = `${SCRIPT_HELPERS}
const opened=await openApp("Notepad");
const ref=async()=>{const view=await tools.computer_read({path:opened.window,views:["ui"]});if(typeof view!=="string")throw Error("UI-only returned pixels");return hints(view)[0];};
// computer_select without values selects the element; computer_type with replace sets its value.
const steps=[["computer_select",{}],["computer_type",{text:"new value",replace:true}]];
for(const [tool,args] of steps) {
 const target=await ref();
 const done=await tools[tool]({window:opened.window,target,...args});
 if(done.outcome!=="delivered")throw Error("Semantic completion lost: "+done.text);
 if((await tools[tool]({window:opened.window,target,...args})).outcome!=="refused")throw Error("Spent ref replayed");
}
const target=await ref();
const failed=await tools.computer_type({window:opened.window,target,text:"provider-failure",replace:true});
if(failed.outcome!=="unknown"||(await tools.computer_type({window:opened.window,target,text:"provider-failure",replace:true})).outcome!=="refused")throw Error("Provider uncertainty was replayed");
text("Strict semantic intents and unknown provider outcome passed");`;
  try {
    const result = await new PiIntegrationTest({ testName: "strict-semantic-actions", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/semantic-actions-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [assistantMessage([toolCall({ id: "semantic", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")])],
    }).run("Exercise strict semantics on synthetic MCP controls only. Never use physical or foreground input.");
    expect(getToolExecution(result, "semantic").isError, getToolResultText(result, "semantic")).toBe(false);
    expect(getToolResultText(result, "semantic")).toContain("Strict semantic intents and unknown provider outcome passed");
    const dispatched = nestedCalls(getToolExecutions(result), "semantic").filter(call => call.computer.action_capability?.route === "accessibility").map(call => call.computer);
    expect(dispatched.map(item => item.status)).toEqual(["delivered", "delivered", "unknown"]);
    for (const item of dispatched.slice(0, 2)) expect(item.action_capability.semantic.app_effect).toBe("unverified");
    expect(dispatched[2].state.attempted).toBe(true);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const actions = calls.filter(c => !["list_apps", "list_windows", "launch_app", "fixture_identity", "get_window_state"].includes(c.name));
    expect(actions.map(c => c.name)).toEqual(Array(3).fill("semantic_action"));
    expect(actions.map(c => c.arguments)).toEqual(["select", "set_value", "set_value"].map((operation, i) => ({
      pid: 42, window_id: 91, element_token: "field", operation,
      ...(operation === "set_value" ? { value: i === 2 ? "provider-failure" : "new value" } : {}),
    })));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
