import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const runCommand = promisify(execFile);
const fixture = (name: string) => path.resolve("test/fixtures", name);
const prelude = `const parse=raw=>JSON.parse(raw.slice(raw.indexOf("{")));
const act=async args=>{try{return parse(await tools.computer_act(args));}catch(e){const message=String(e.message);if(message.includes('Validation failed for tool "computer_act"'))return {status:"schema_refused"};return parse(message);}};
const observe=async window=>tools.computer_observe({window_ref:window,capture:{hints:false}});
const control=async operation=>tools.fixture_pointer_control({operation});
const open=async()=>parse(await tools.computer_open({app:"Notepad"})).window_ref;
const first=await open(),second=await open();
store("first",first);store("second",second);`;

// With PI_HOVER_IDE_SOURCE set, load and record that exact current checkout rather than an installed historical IDE.
async function scenario(testName: string, code: string) {
  await mkdir(".tmp/lpt-729", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/lpt-729/pi-pointer-")), log = path.join(cwd, "calls.jsonl");
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({ command: process.execPath,
      args: [fixture("pointer-hover-driver.mjs"), log] }));
    const ide = process.env.PI_HOVER_IDE_SOURCE;
    let provenance: { source: string; commit: string; version: string } | undefined;
    if (ide) {
      await runCommand("git", ["-C", ide, "fetch", "origin", "develop"]);
      const { stdout: changed } = await runCommand("git", ["-C", ide, "status", "--porcelain"]);
      expect(changed.trim(), "The loaded IDE checkout must be clean").toBe("");
      const { stdout } = await runCommand("git", ["-C", ide, "rev-parse", "HEAD", "origin/develop"]);
      const [head, develop] = stdout.trim().split("\n");
      expect(head, "The loaded IDE checkout must match latest fetched origin/develop").toBe(develop);
      provenance = { source: path.resolve(ide), commit: head,
        version: JSON.parse(await readFile(path.join(ide, "package.json"), "utf8")).version };
    }
    const result = await new PiIntegrationTest({ testName, artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [...(ide ? [path.resolve(ide, "src/pi-agent-ide.ts")] : []), fixture("pointer-hover-extension.ts")],
      isolateUserResources: true,
      piCommand: process.env.PI_HOVER_PI_COMMAND,
      tools: ["codemode", "computer_open", "computer_windows", "computer_observe", "computer_act", "computer_close", "fixture_pointer_control"],
      conversation: [assistantMessage([toolCall({ id: "pointer", name: "codemode", arguments: { code: prelude + "\n" + code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_close", arguments: {} })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")])],
    }).run("Exercise native pointer admission against synthetic MCP windows only. Never operate a real desktop.");
    if (provenance) {
      const { stdout } = await runCommand("git", ["-C", provenance.source, "rev-parse", "HEAD"]);
      expect(stdout.trim(), "The IDE source must not change during the run").toBe(provenance.commit);
      await writeFile(path.join(result.artifacts.directory, "ide-source.json"), JSON.stringify(provenance, null, 2));
    }
    expect(getToolExecution(result, "pointer").isError, getToolResultText(result, "pointer")).toBe(false);
    expect(getToolResultText(result, "pointer")).toContain("Pointer contract passed");
    return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

// Protects the production Pi schema/Codemode/session/MCP boundary, not native hover UI effects.
test("real Pi grounds move and bounded hover once and preserves refusal and uncertain receipts without fallback", async () => {
  const calls = await scenario("native-pointer-receipts", `
let view=await observe(first),other=await observe(second);
const base={window_ref:first,observation_id:view.observation_id};
if((await act({...base,action:"move",x:100,y:80,window_ref:second})).status!=="refused")throw Error("Wrong-window observation admitted");
if((await act({...base,action:"hover",hint:other.ui.elements[0].hint,dwell_ms:100})).status!=="refused")throw Error("Foreign hint admitted");
const background=await act({...base,action:"move",x:100,y:80});
if(background.status!=="refused"||background.state.code!=="background_unavailable"||background.state.attempted!==false)throw Error("Background refusal lost");
if((await act({...base,action:"move",x:100,y:80,delivery_mode:"foreground"})).status!=="refused")throw Error("Refused observation replayed");
view=await observe(first);
const hover={window_ref:first,observation_id:view.observation_id,action:"hover",hint:view.ui.elements[0].hint,dwell_ms:100,delivery_mode:"foreground"};
const hovered=await act(hover);
if(hovered.status!=="delivered"||hovered.state.dwell_elapsed_ms!==100||hovered.state.foreground_changed!==null||hovered.action_capability.actual_delivery!=="foreground")throw Error("Truthful hover completion lost");
if((await act(hover)).status!=="refused")throw Error("Hover replayed");
view=await tools.computer_observe({window_ref:first,capture:{granularity:"image"}});
if((await act({window_ref:first,observation_id:view.observation_id,action:"move",x:120,y:90,delivery_mode:"foreground"})).status!=="delivered")throw Error("Image-only move refused");
await control("partial");view=await observe(first);
const partial={window_ref:first,observation_id:view.observation_id,action:"hover",element_token:view.ui.elements[0].element_token,dwell_ms:100,delivery_mode:"foreground"};
const interrupted=await act(partial);
if(interrupted.status!=="unknown"||interrupted.state.attempted!==true||interrupted.state.delivered!==true||interrupted.state.dwell_elapsed_ms!==20)throw Error("Interrupted native prefix lost");
if((await act(partial)).status!=="refused")throw Error("Unknown pointer replayed");
await control("malformed");view=await observe(first);
const malformed={window_ref:first,observation_id:view.observation_id,action:"move",x:130,y:100,delivery_mode:"foreground"};
if((await act(malformed)).status!=="unknown")throw Error("Malformed successful receipt called delivered");
if((await act(malformed)).status!=="refused")throw Error("Malformed outcome replayed");
view=await observe(first);
for(const command of [
 {action:"hover",x:10,y:10}, {action:"hover",x:10,y:10,dwell_ms:0}, {action:"hover",x:10,y:10,dwell_ms:10001},
 {action:"move",x:10,y:10,dwell_ms:1}, {action:"move",x:10,y:10,button:"left"},
 {action:"sequence",sequence:[{action:"move",x:10,y:10}]}
])if(!["refused","schema_refused"].includes((await act({window_ref:first,observation_id:view.observation_id,...command})).status))throw Error("Unsupported pointer request admitted");
text("Pointer contract passed: admission, receipts and no replay");`);
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
  const calls = await scenario("native-pointer-access", `
const listed=parse(await tools.computer_windows({}));
const external=listed.state.windows.find(w=>w.title==="Unowned fixture").window_ref;
const externalView=await observe(external);
await control("safe");
if((await act({window_ref:external,observation_id:externalView.observation_id,action:"move",x:100,y:80,delivery_mode:"foreground"})).status!=="refused")throw Error("Safe sent input to external window");
let view=await observe(first);
if((await act({window_ref:first,observation_id:view.observation_id,action:"hover",hint:view.ui.elements[0].hint,dwell_ms:100,delivery_mode:"foreground"})).status!=="delivered")throw Error("Safe denied owned window");
view=await observe(first);await control("close_first");
if((await act({window_ref:first,observation_id:view.observation_id,action:"move",x:100,y:80,delivery_mode:"foreground"})).status!=="refused")throw Error("Closed window admitted");
view=await observe(second);await control("recycle_second");
if((await act({window_ref:second,observation_id:view.observation_id,action:"hover",hint:view.ui.elements[0].hint,dwell_ms:100,delivery_mode:"foreground"})).status!=="refused")throw Error("Reused handle admitted");
text("Pointer contract passed: Safe and native lifetime guards");`);
  const actions = calls.filter(c => !["list_apps", "list_windows", "launch_app", "fixture_identity", "get_window_state", "fixture_control"].includes(c.name));
  expect(actions).toEqual([{ name: "move_pointer", arguments: {
    pid: 42, window_id: 91, element_token: expect.any(String), dwell_ms: 100, delivery_mode: "foreground",
  } }]);
});
