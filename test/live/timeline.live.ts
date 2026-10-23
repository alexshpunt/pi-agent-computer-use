import { afterAll, beforeAll, expect, test } from "vitest";
import { connectLive, serveFixture, text } from "./remote.ts";

// Serve scripts/web-fixture.mjs on the machine, open its /input page in an owned remote browser,
// send native timelines to the browser window and read what the page itself recorded.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
const journal = fixture.journal;
let window = "";

beforeAll(async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", browser: "msedge", url: `${fixture.base}/input` });
  expect(opened.details.status, text(opened)).toBe("observed");
  window = `computer:window/${opened.details.window_ref}`;
});
afterAll(async () => { await live.close(); fixture.close(); });

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

test("cancelling a timeline mid-way leaves no key or button held", async () => {
  const before = (await journal()).length;
  const view = await live.read(window, ["image"]);
  const abort = new AbortController();
  const done = live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, { action: "timeline", events: [
    { at_ms: 0, type: "move", x: 400, y: 400 }, { at_ms: 20, type: "key_down", key: "shift" }, { at_ms: 40, type: "button_down", button: "right" },
    ...Array.from({ length: 30 }, (_, i) => ({ at_ms: 100 + i * 100, type: "move", x: 400 + i * 5, y: 400 })),
    { at_ms: 3200, type: "button_up", button: "right" }, { at_ms: 3220, type: "key_up", key: "shift" }] }, abort.signal);
  setTimeout(() => abort.abort(), 1000);
  const result = await done;
  console.log("cancelled", result.details.status, text(result).slice(0, 200));
  await new Promise(resolve => setTimeout(resolve, 3000));
  const events = (await journal()).slice(before).map(e => `${e.type}:${e.button ?? e.key ?? ""}`);
  console.log(events.join(" "));
  expect(events).toContain("pointerdown:2");
  expect(events).toContain("pointerup:2");
  expect(events).toContain("keyup:Shift");
  const held = await live.powershell(`Add-Type -Name K -Namespace PiLive -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);'; (1,2,4,16 | Where-Object { [PiLive.K]::GetAsyncKeyState($_) -band 0x8000 }) -join ','`);
  expect(held.trim()).toBe("");
});
