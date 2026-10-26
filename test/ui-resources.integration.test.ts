import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolExecutions, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { nestedCalls, SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

test("real Pi Codemode refines full resources locally and dispatches only a current enabled hint", async () => {
  await mkdir(".tmp/ui-resources", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/ui-resources/pi-contract-")); const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/ui-resources-driver.mjs"), log],
  }));
  // Any refused input spends its observation, so each refusal check acts on a fresh overview.
  const code = `${SCRIPT_HELPERS}
const listed = await windows();
const [win, otherWin] = [...listed.matchAll(/computer:[\\w-]+\\/w\\d+[a-z]{2}/g)].map(match => match[0]);
const read = views => tools.computer_read({path:win,...(views?{views}:{})});
// Only local refinement is under test here: clicks skip the default successor, so every native capture is a read.
const click = async (view,hint) => (await insert(observation(view),{action:"click",hint,successor:false})).outcome;
const first = await read(['capture:{"max_elements":200,"max_depth":15,"guides":{"grid":true,"action":true}}']);
if (!/UI: collected=200, complete=false/.test(body(first))) throw Error("Lost full resource");
const candidates = await tools.computer_search({path:observation(first),query:"Save",limit:2});
const [uiHint, disabledHint] = hints(candidates);
if (!uiHint || !disabledHint || !/enabled=false/.test(candidates.split("\\n").find(line => line.startsWith(disabledHint + " |")))) throw Error("Missing candidates");
const inspect = await tools.computer_read({path:observation(first),views:["element:inspect,"+uiHint]});
if (typeof inspect !== "string" || hints(inspect)[0] !== uiHint) throw Error("Inspection rebound target");
const marked = await tools.computer_read({path:observation(first),views:["element:highlight,"+uiHint]});
if (typeof marked === "string") throw Error("Missing selected image");
if ((await click(first, disabledHint)) !== "refused") throw Error("Disabled input admitted");
const current = await read();
const other = await tools.computer_read({path:otherWin});
if ((await click(current, hints(other)[1])) !== "refused") throw Error("Foreign hint admitted");
let latest = await read(['capture:{"max_elements":3,"hints":false}']);
if ((await click(latest, uiHint)) !== "refused") throw Error("Old alias rebound");
latest = await read(['capture:{"max_elements":3,"hints":false}']);
const target = observation(latest);
const delivered = await insert(target,{action:"click",hint:hints(latest)[1],successor:false});
if (delivered.outcome !== "delivered") throw Error("Current hint not dispatched");
if ((await insert(target,{action:"click",hint:hints(latest)[1],successor:false})).outcome !== "refused") throw Error("Consumed hint replayed");
text("UI resource guards passed: 200 collected, 199 search matches, one native click");`;
  try {
    const result = await new PiIntegrationTest({
      testName: "ui-resources", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [
        assistantMessage([toolCall({ id: "ui", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Refine observed UI resources locally and act only on the exact current enabled target.");
    expect(getToolExecution(result, "ui").isError, getToolResultText(result, "ui")).toBe(false);
    expect(getToolResultText(result, "ui")).toContain("UI resource guards passed");
    const nested = nestedCalls(getToolExecutions(result), "ui");
    // Calls in script order: window search, first read, observation search, inspect, highlight.
    const [, first, search, inspect, marked] = nested;
    expect(first.computer.agent_image.annotation.guides.grid.status).toBe("shown");
    expect(first.computer.ui).toMatchObject({ complete: false });
    expect(first.computer.ui.elements).toHaveLength(200);
    expect(search.name).toBe("computer_search");
    expect(search.computer).toMatchObject({ ui: { matches: 199, projection_truncated: true } });
    expect(inspect.computer.agent_image).toBeUndefined();
    expect(inspect.computer.ui.elements[0].element_token).toBe(search.computer.ui.elements[0].element_token);
    expect(marked.computer.agent_image.annotation.selected_hint).toBe(search.computer.ui.elements[0].hint);
    const delivered = nested.filter(call => call.name === "computer_insert" && call.computer.status === "delivered");
    expect(delivered.map(call => call.computer.state.path)).toEqual(["ax"]);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(c => c.name === "get_window_state")).toHaveLength(5);
    expect(calls.filter(c => c.name === "click").map(c => c.arguments.element_token)).toEqual(["s5:1"]);
    expect(calls.some(c => ["bring_to_front", "scroll", "zoom"].includes(c.name))).toBe(false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
