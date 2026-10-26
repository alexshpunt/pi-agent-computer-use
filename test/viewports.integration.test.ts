import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

// LPT-931: a viewport through real Pi: computer_view makes it, Read shows it, an input tool takes points of its image.
test("real Pi makes a viewport, reads it and clicks at a point of its image", async () => {
  await mkdir(".tmp/viewports", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/viewports/pi-contract-"));
  const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/observation-granularity-driver.mjs"), log],
  }));
  const code = `${SCRIPT_HELPERS}
const win = address(await windows(), "window");
await tools.computer_read({path:win,views:["image"]});
const pano = win + "/pano";
const made = await tools.computer_view({viewport:pano,x:100,y:50,width:200,height:120});
if (made.outcome !== "observed" || !made.viewport || !made.viewport.endsWith("/pano")) throw Error("View failed: " + JSON.stringify(made));
const read = await tools.computer_read({path:made.viewport});
if (typeof read === "string" || !/Its image is 200x120/.test(read.note ?? JSON.stringify(read))) throw Error("Read of the viewport changed: " + JSON.stringify(read).slice(0, 400));
const clicked = await tools.computer_click({window:made.viewport,x:10,y:20});
if (clicked.outcome !== "delivered" || clicked.viewport !== made.viewport) throw Error("Click failed: " + JSON.stringify(clicked));
const outside = await tools.computer_click({window:made.viewport,x:250,y:20});
if (outside.outcome !== "refused" || outside.effect !== "not-applied") throw Error("A point outside the viewport was sent");
const removed = await tools.computer_delete({path:made.viewport});
if (removed.outcome !== "closed") throw Error("Delete failed: " + JSON.stringify(removed));
text("Viewport contract passed: " + made.viewport);
`;
  try {
    const result = await new PiIntegrationTest({
      testName: "viewports", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [
        assistantMessage([toolCall({ id: "view", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Work in a viewport of the window.");
    expect(getToolExecution(result, "view").isError, getToolResultText(result, "view")).toBe(false);
    expect(getToolResultText(result, "view")).toMatch(/Viewport contract passed: computer:local\/w1[a-z]{2}\/pano/);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    // The click went to the viewport's point in the window's full-resolution pixels; the refused one sent nothing.
    expect(calls.filter(c => c.name === "click").map(c => [c.arguments.x, c.arguments.y])).toEqual([[110, 70]]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
