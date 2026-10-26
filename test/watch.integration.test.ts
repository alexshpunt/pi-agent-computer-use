import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { SCRIPT_HELPERS } from "./fixtures/standalone-computer.ts";

// LPT-930: a watch through real Pi: frames of a viewport arrive while a drag runs, the drag's receipt names its span
// in the watch, the newest frame reads while the watch runs, and watch_stop returns the sheet, statistics and files.
test("real Pi watches a viewport while a drag moves its content and stops with frames of the motion", async () => {
  await mkdir(".tmp/watch", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/watch/pi-contract-"));
  const log = path.join(cwd, "calls.jsonl");
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(path.join(cwd, ".pi/computer-use.json"), JSON.stringify({
    command: process.execPath, args: [path.resolve("test/fixtures/watch-driver.mjs"), log],
  }));
  const code = `${SCRIPT_HELPERS}
const win = address(await windows(), "window");
await tools.computer_read({path:win,views:["image"]});
const lane = (await tools.computer_view({viewport:win + "/lane",x:0,y:100,width:1000,height:200})).viewport;
const started = await tools.computer_record({at:lane,action:"watch",fps:20});
if (started.outcome !== "observed" || !started.watch) throw Error("Watch did not start: " + JSON.stringify(started).slice(0, 600));
const dragged = await tools.computer_drag({window:win,from:{x:100,y:200},to:{x:700,y:200},duration_ms:800});
if (dragged.outcome !== "delivered") throw Error("Drag failed: " + JSON.stringify(dragged).slice(0, 600));
const latest = await tools.computer_read({path:started.watch,views:["frames:last"]});
const stopped = await tools.computer_record({at:started.watch,action:"watch_stop",to:"watch-out",video:true});
if (stopped.outcome !== "observed") throw Error("Stop failed: " + JSON.stringify(stopped).slice(0, 600));
const again = await tools.computer_record({at:started.watch,action:"watch_stop"});
text(JSON.stringify({ watch: started.watch, spans: dragged.watch_spans, latest: typeof latest === "string" ? latest : latest.outcome ?? "image", again: again.outcome }));
`;
  try {
    const result = await new PiIntegrationTest({
      testName: "watch", artifactsDir: testArtifactsDir(import.meta.filename), cwd,
      extensions: [path.resolve("test/fixtures/display-extension.ts")], isolateUserResources: true,
      tools: ["codemode", "computer_delete"],
      conversation: [
        assistantMessage([toolCall({ id: "watch", name: "codemode", arguments: { code } })], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "close", name: "computer_delete", arguments: { path: "computer:session" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Watch the lane while dragging.");
    expect(getToolExecution(result, "watch").isError, getToolResultText(result, "watch")).toBe(false);
    const report = JSON.parse(getToolResultText(result, "watch").match(/\{"watch".*\}/)![0]);
    // The drag ran 800 ms at 20 FPS: its receipt names the watch and frames captured while it ran.
    expect(report.spans).toHaveLength(1);
    expect(report.spans[0].sequence).toBe(report.watch);
    expect(report.spans[0].to_ms - report.spans[0].from_ms).toBeGreaterThanOrEqual(800);
    expect(report.spans[0].frames.to - report.spans[0].frames.from).toBeGreaterThanOrEqual(5);
    // A stopped watch is no longer one.
    expect(report.again).toBe("refused");

    // The files: watch.json lists every frame; frames during the drag changed as the square moved; the animation exists.
    const out = path.join(cwd, "watch-out");
    const json = JSON.parse(await readFile(path.join(out, "watch.json"), "utf8"));
    expect(json.actions.map((action: { label: string }) => action.label)).toEqual(["drag"]);
    const during = json.frames.filter((frame: { actions: string[] }) => frame.actions.includes("drag"));
    expect(during.filter((frame: { changed_share: number }) => frame.changed_share > 0).length).toBeGreaterThanOrEqual(4);
    // The viewport crops the lane: 1000x200 window pixels, frames at most 800 px wide.
    expect(json.frames[0].width).toBe(800);
    expect(json.frames[0].height).toBe(160);
    for (const frame of json.frames) await access(path.join(out, frame.file));
    await access(path.join(out, "watch.webp"));

    // Two driver processes: the session's own did the drag, the second one captured the frames.
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const dragPid = calls.find(call => call.name === "drag").pid;
    const capturePids = new Set(calls.filter(call => call.name === "get_window_state" && call.at > calls.find(c => c.name === "drag").at).map(call => call.pid));
    expect([...capturePids].some(pid => pid !== dragPid)).toBe(true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
