import { afterAll, beforeAll, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { connectLive, text } from "./remote.ts";
import { machineConfig } from "../../src/machine.ts";
import { sshRunner } from "../../src/runner.ts";

// Serve scripts/web-fixture.mjs on the machine, open its /input page in an owned remote browser,
// send native timelines to the browser window and read what the page itself recorded.
const live = await connectLive();
const runner = sshRunner((await machineConfig(process.cwd(), process.env.LIVE_MACHINE ?? "zinpc")).ssh);
let fixture: ReturnType<typeof runner.spawn> | undefined, base = "", window = "";
const journal = async () => JSON.parse(await runner.run("curl", ["-s", `${base}/journal`])) as { type: string; [key: string]: unknown }[];

beforeAll(async () => {
  await runner.run("dd", ["status=none", "of=/tmp/pi-web-fixture.mjs"], { input: await readFile("scripts/web-fixture.mjs") });
  fixture = runner.spawn("node", ["/tmp/pi-web-fixture.mjs"]);
  base = await new Promise<string>((resolve, reject) => {
    fixture!.stdout.on("data", (chunk: Buffer) => { const match = /FIXTURE (\S+)/.exec(chunk.toString()); if (match) resolve(match[1].replace(/\/$/, "")); });
    fixture!.on("exit", () => reject(new Error("fixture exited")));
  });
  const opened = await live.insert(live.machine, { action: "open_browser", browser: "msedge", url: `${base}/input` });
  expect(opened.details.status, text(opened)).toBe("observed");
  window = `computer:window/${opened.details.window_ref}`;
});
afterAll(async () => { await live.close(); fixture?.stdin.end(); fixture?.kill(); });

const timeline = async (events: unknown[]) => {
  const view = await live.read(window, ["image"]);
  const done = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, { action: "timeline", events });
  expect(done.details.status, text(done)).toBe("delivered");
  return view.details.agent_image as { output: { width: number; height: number } };
};

test("buttons, held keys and wheel during a hold arrive in order", async () => {
  const before = (await journal()).length;
  const image = await timeline([{ at_ms: 0, type: "move", x: 400, y: 400 }]);
  const { width, height } = image.output;
  const cx = Math.round(width / 2), cy = Math.round(height * 0.6);
  await timeline([
    { at_ms: 0, type: "move", x: cx, y: cy },
    { at_ms: 50, type: "key_down", key: "shift" },
    { at_ms: 80, type: "button_down", button: "middle" },
    { at_ms: 120, type: "move", x: cx + 40, y: cy + 10 },
    { at_ms: 160, type: "move", x: cx + 80, y: cy + 20 },
    { at_ms: 200, type: "wheel", dy: 2 },
    { at_ms: 240, type: "button_up", button: "middle" },
    { at_ms: 260, type: "key_up", key: "shift" },
    { at_ms: 300, type: "button_down", button: "right" },
    { at_ms: 340, type: "move", x: cx + 20, y: cy + 40 },
    { at_ms: 380, type: "button_up", button: "right" },
    { at_ms: 420, type: "key_down", key: "w" },
    { at_ms: 440, type: "move", x: cx, y: cy },
    { at_ms: 520, type: "key_up", key: "w" },
  ]);
  await new Promise(r => setTimeout(r, 500));
  const events = (await journal()).slice(before).map(e => `${e.type}:${e.button ?? e.key ?? ""}:${e.shift ?? ""}:${e.buttons ?? ""}`);
  console.log(events.join(" "));
  expect(events).toEqual(expect.arrayContaining(["pointerdown:1:true:4", "pointerup:1:true:0", "pointerdown:2:false:2", "pointerup:2:false:0", "keydown:w::0", "keyup:w::0"]));
  const wheel = (await journal()).slice(before).find(e => e.type === "wheel")!;
  expect(wheel).toMatchObject({ buttons: 4 });
  expect(Number(wheel.deltaY)).toBeGreaterThan(0);
});

test("pen strokes report pressure and tilt", async () => {
  const before = (await journal()).length;
  const points = Array.from({ length: 20 }, (_, i) => ({ at_ms: 20 + i * 15, type: "pen_move", x: 300 + i * 10, y: 500, pressure: Math.round((0.1 + i * 0.04) * 100) / 100, tilt_x: 20 }));
  await timeline([{ at_ms: 0, type: "pen_down", x: 300, y: 500, pressure: 0.1, tilt_x: 20 }, ...points, { at_ms: 340, type: "pen_up", x: 490, y: 500 }]);
  await new Promise(r => setTimeout(r, 500));
  const pens = (await journal()).slice(before).filter(e => e.pointerType === "pen");
  console.log(pens.map(e => `${e.type}:${e.pressure}:${e.tiltX}`).join(" "));
  expect(pens.some(e => e.type === "pointerdown")).toBe(true);
  const pressures = pens.filter(e => e.type === "pointermove").map(e => Number(e.pressure));
  expect(Math.max(...pressures)).toBeGreaterThan(Math.min(...pressures) + 0.3);
  expect(pens.find(e => e.type === "pointerdown")).toMatchObject({ tiltX: 20 });
});

test("relative motion reaches a pointer-locked page", async () => {
  const before = (await journal()).length;
  await timeline([
    { at_ms: 0, type: "move", x: 500, y: 450 },
    { at_ms: 30, type: "button_down" }, { at_ms: 50, type: "button_up" },
    { at_ms: 90, type: "button_down" }, { at_ms: 110, type: "button_up" },
    ...Array.from({ length: 10 }, (_, i) => ({ at_ms: 400 + i * 20, type: "move_relative", dx: 10, dy: -5 })),
    { at_ms: 900, type: "key_down", key: "escape" }, { at_ms: 920, type: "key_up", key: "escape" },
  ]);
  await new Promise(r => setTimeout(r, 600));
  const events = (await journal()).slice(before);
  console.log(events.filter(e => /lock/.test(e.type)).map(e => JSON.stringify(e)).join(" "));
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "pointerlock", locked: true })]));
  const moved = events.filter(e => e.type === "locked-move").reduce((sum, e) => ({ x: sum.x + Number(e.x), y: sum.y + Number(e.y) }), { x: 0, y: 0 });
  expect(moved.x).toBeGreaterThan(50);
  expect(moved.y).toBeLessThan(-20);
});
