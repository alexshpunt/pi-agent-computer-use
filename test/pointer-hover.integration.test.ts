import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

const fixture = (name: string) => path.resolve("test/fixtures", name);
// Any refused input spends its observation, so each check that must reach the session uses a fresh overview.
const prelude = `${SCRIPT_HELPERS}
const act=async(view,command)=>(await insert(typeof view==="string"?view:observation(view),command)).outcome;
const observe=async window=>tools.computer_read({path:window,views:['capture:{"hints":false}']});
const control=async operation=>tools.fixture_pointer_control({operation});
const open=async()=>(await openApp("Notepad")).window;
const first=await open(),second=await open();`;

// Run standalone computer-use through Pi SDK Codemode, without loading Pi Agent IDE.
async function scenario(testName: string, code: string) {
  await mkdir(".tmp/lpt-729", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-729/pi-pointer-")), log = path.join(cwd, "calls.jsonl");
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [fixture("pointer-hover-driver.mjs"), log] }));
    const result = await new PiIntegrationTest({ testName, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [fixture("pointer-hover-extension.ts")],
      isolateUserResources: true,
      piCommand: process.env.PI_HOVER_PI_COMMAND,
      tools: ["codemode", "computer_insert", "fixture_pointer_control"],
      conversation: [assistantMessage([toolCall({ id: "pointer", name: "codemode", arguments: { code: prelude + "\n" + code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")])],
    }).run("Exercise native pointer admission against synthetic MCP windows only. Never operate a real desktop.");
    expect(getToolExecution(result, "pointer").isError, getToolResultText(result, "pointer")).toBe(false);
    expect(getToolResultText(result, "pointer")).toContain("Pointer contract passed");
    return { calls: (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)), nested: nestedCalls(getToolExecutions(result), "pointer") };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

// Protects the production Pi schema/Codemode/session/MCP boundary, not native hover UI effects.
test("real Pi grounds move and bounded hover once and preserves refusal and uncertain receipts without fallback", async () => {
  const { calls, nested } = await scenario("native-pointer-receipts", `
let view=await observe(first);const other=await observe(second);
// The observation address binds its window; identity fields cannot redirect it.
if(await act(view,{action:"move",x:100,y:80,window_ref:second})!=="refused")throw Error("Wrong-window observation admitted");
if(await act(view,{action:"hover",hint:hints(other)[0],dwell_ms:100})!=="refused")throw Error("Foreign hint admitted");
view=await observe(first);
const background=await insert(observation(view),{action:"move",x:100,y:80});
if(background.outcome!=="refused"||background.code!=="background_unavailable"||background.effect!=="not-applied")throw Error("Background refusal lost");
if(await act(view,{action:"move",x:100,y:80,delivery_mode:"foreground"})!=="refused")throw Error("Refused observation replayed");
view=await observe(first);
const hover={action:"hover",hint:hints(view)[0],dwell_ms:100,delivery_mode:"foreground"};
if(await act(view,hover)!=="delivered")throw Error("Truthful hover completion lost");
if(await act(view,hover)!=="refused")throw Error("Hover replayed");
view=await tools.computer_read({path:first,views:["image"]});
if(await act(view,{action:"move",x:120,y:90,delivery_mode:"foreground"})!=="delivered")throw Error("Image-only move refused");
await control("partial");view=await observe(first);
const partial={action:"hover",hint:hints(view)[0],dwell_ms:100,delivery_mode:"foreground"};
if(await act(view,partial)!=="unknown")throw Error("Interrupted native prefix lost");
if(await act(view,partial)!=="refused")throw Error("Unknown pointer replayed");
await control("malformed");view=await observe(first);
const malformed={action:"move",x:130,y:100,delivery_mode:"foreground"};
if(await act(view,malformed)!=="unknown")throw Error("Malformed successful receipt called delivered");
if(await act(view,malformed)!=="refused")throw Error("Malformed outcome replayed");
for(const command of [
 {action:"hover",x:10,y:10}, {action:"hover",x:10,y:10,dwell_ms:0}, {action:"hover",x:10,y:10,dwell_ms:10001},
 {action:"move",x:10,y:10,dwell_ms:1}, {action:"move",x:10,y:10,button:"left"},
 {action:"sequence",sequence:[{action:"move",x:10,y:10}]}
]){view=await observe(first);if(await act(view,command)!=="refused")throw Error("Unsupported pointer request admitted: "+JSON.stringify(command));}
text("Pointer contract passed: admission, receipts and no replay");`);
  const outcomes = nested.filter(call => call.name === "computer_insert").map(call => call.computer);
  const hovered = outcomes.find(item => item.status === "delivered" && item.state?.dwell_elapsed_ms !== undefined)!;
  expect(hovered.state).toMatchObject({ dwell_elapsed_ms: 100, foreground_changed: null });
  expect(hovered.action_capability.actual_delivery).toBe("foreground");
  const interrupted = outcomes.find(item => item.status === "unknown" && item.state?.attempted === true)!;
  expect(interrupted.state).toMatchObject({ attempted: true, delivered: true, dwell_elapsed_ms: 20 });
  const refusedBackground = outcomes.find(item => item.state?.code === "background_unavailable")!;
  expect(refusedBackground.state.attempted).toBe(false);
  const actions = calls.filter(c => !["list_apps", "list_windows", "launch_app", "fixture_identity", "get_window_state", "fixture_control"].includes(c.name));
  expect(actions.map(c => c.name)).toEqual(Array(5).fill("move_pointer"));
  expect(actions.map(c => c.arguments)).toEqual([
    { pid: 42, window_id: 91, capture_id: expect.any(String), x: 100, y: 80, dwell_ms: 0, delivery_mode: "background" },
    { pid: 42, window_id: 91, element_token: expect.any(String), dwell_ms: 100, delivery_mode: "foreground" },
    { pid: 42, window_id: 91, capture_id: expect.any(String), x: 120, y: 90, dwell_ms: 0, delivery_mode: "foreground" },
    { pid: 42, window_id: 91, element_token: expect.any(String), dwell_ms: 100, delivery_mode: "foreground" },
    { pid: 42, window_id: 91, capture_id: expect.any(String), x: 130, y: 100, dwell_ms: 0, delivery_mode: "foreground" },
  ]);
  expect(new Set(actions.filter(c => c.arguments.capture_id).map(c => c.arguments.capture_id)).size).toBe(3);
});

test("real Pi never sends pointer input through Safe-disallowed, closed or reused window references", async () => {
  const { calls } = await scenario("native-pointer-access", `
const listed=await windows();
const external=listed.split("\\n").find(line=>line.includes("| Unowned fixture |")).match(/computer:[\\w-]+\\/w\\d+[a-z]{2}/)[0];
const externalView=await observe(external);
await control("safe");
if(await act(externalView,{action:"move",x:100,y:80,delivery_mode:"foreground"})!=="refused")throw Error("Safe sent input to external window");
let view=await observe(first);
if(await act(view,{action:"hover",hint:hints(view)[0],dwell_ms:100,delivery_mode:"foreground"})!=="delivered")throw Error("Safe denied owned window");
view=await observe(first);await control("close_first");
if(await act(view,{action:"move",x:100,y:80,delivery_mode:"foreground"})!=="refused")throw Error("Closed window admitted");
view=await observe(second);await control("recycle_second");
if(await act(view,{action:"hover",hint:hints(view)[0],dwell_ms:100,delivery_mode:"foreground"})!=="refused")throw Error("Reused handle admitted");
text("Pointer contract passed: Safe and native lifetime guards");`);
  const actions = calls.filter(c => !["list_apps", "list_windows", "launch_app", "fixture_identity", "get_window_state", "fixture_control"].includes(c.name));
  expect(actions).toEqual([{ name: "move_pointer", arguments: {
    pid: 42, window_id: 91, element_token: expect.any(String), dwell_ms: 100, delivery_mode: "foreground",
  } }]);
});
