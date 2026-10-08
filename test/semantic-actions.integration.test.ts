import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

// Protects the real Pi schema/Codemode/session/MCP boundary, not Windows application effects.
test("real Pi dispatches explicit UIA intents once and keeps provider uncertainty without a physical fallback", async () => {
  await mkdir(".tmp/lpt-626", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-626/pi-semantic-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
    args: [path.resolve("test/fixtures/complete-input-driver.mjs"), log, "semantic"] }));
  const code = `const raw=await tools.computer_open({app:"Notepad"});
const opened=JSON.parse(raw.slice(raw.indexOf("{")));
store("window",opened.window_ref);
const act=async args=>{try {const r=await tools.computer_act(args);return JSON.parse(r.slice(r.indexOf("{")));}catch(e){const r=String(e.message);return JSON.parse(r.slice(r.indexOf("{")));}};
for(const action of ["invoke","select","set_value"]) {
 const view=await tools.computer_observe({window_ref:load("window"),capture:{granularity:"ui"}});
 if(view.image) throw Error("UI-only returned pixels");
 const args={window_ref:load("window"),observation_id:view.observation_id,action,element_token:"field",...(action==="set_value"?{text:"new value"}:{})};
 const r=await act(args);
 if(r.status!=="delivered"||r.action_capability.route!=="accessibility"||r.action_capability.semantic.app_effect!=="unverified")throw Error("Semantic completion lost");
 if((await act(args)).status!=="refused")throw Error("Consumed token replayed");
}
const view=await tools.computer_observe({window_ref:load("window"),capture:{granularity:"ui"}});
const args={window_ref:load("window"),observation_id:view.observation_id,action:"set_value",element_token:"field",text:"provider-failure"};
const failed=await act(args);
if(failed.status!=="unknown"||failed.state.attempted!==true||(await act(args)).status!=="refused")throw Error("Provider uncertainty was replayed");
text("Strict semantic intents and unknown provider outcome passed");`;
  try {
    const result = await new PiIntegrationTest({ testName: "strict-semantic-actions", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/semantic-actions-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_open", "computer_observe", "computer_act", "computer_close"],
      conversation: [assistantMessage([toolCall({ id: "semantic", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")])],
    }).run("Exercise strict semantics on synthetic MCP controls only. Never use physical or foreground input.");
    expect(getToolExecution(result, "semantic").isError, getToolResultText(result, "semantic")).toBe(false);
    expect(getToolResultText(result, "semantic")).toContain("Strict semantic intents and unknown provider outcome passed");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const actions = calls.filter(c => !["list_apps", "list_windows", "launch_app", "fixture_identity", "get_window_state"].includes(c.name));
    expect(actions.map(c => c.name)).toEqual(Array(4).fill("semantic_action"));
    expect(actions.map(c => c.arguments)).toEqual(["invoke", "select", "set_value", "set_value"].map((operation, i) => ({
      pid: 42, window_id: 91, element_token: "field", operation,
      ...(operation === "set_value" ? { value: i === 3 ? "provider-failure" : "new value" } : {}),
    })));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
