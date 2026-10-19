import { afterAll, beforeAll, expect, test } from "vitest";
import { connectLive, text } from "./remote.ts";

const live = await connectLive();
let window = "", pid = 0;
beforeAll(async () => {
  const opened = await live.insert(live.machine, { action: "open", app: "Paint" });
  window = `computer:window/${opened.details.window_ref}`;
  pid = opened.details.target!.pid;
});
afterAll(async () => { if (pid) await live.kill(pid); await live.close(); });

const stroke = (i: number) => {
  const x = 250 + (i % 30) * 25, y = 250 + Math.floor(i / 30) * 40;
  return { action: "drag", from_x: x, from_y: y, via: [{ x: x + 6, y: y + 12 }], to_x: x + 12, to_y: y + 24, duration_ms: 60 };
};

test("a 300-stroke program runs as one call", async () => {
  const view = await live.read(window, ["image"]);
  expect(view.details.status, text(view)).toBe("observed");
  const started = Date.now();
  const done = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`,
    { action: "sequence", sequence: Array.from({ length: 300 }, (_, i) => stroke(i)) });
  console.log(`300 strokes: ${Date.now() - started} ms`);
  expect(done.details.status, text(done)).toBe("delivered");
  expect(done.details.state).toMatchObject({ sequence: { total: 300, completed: 300 } });
});

test("one observation serves 20 calls while the window keeps its size, then expires on resize", async () => {
  const view = await live.read(window, ["image"]);
  const observation = `computer:observation/${view.details.observation_id}?delivery=foreground`;
  const started = Date.now();
  for (let i = 0; i < 20; i++) {
    const done = await live.insert(observation, { action: "drag", from_x: 300 + i * 20, from_y: 600, via: [{ x: 305 + i * 20, y: 620 }], to_x: 310 + i * 20, to_y: 640, duration_ms: 40 });
    expect(done.details.status, text(done)).toBe("delivered");
  }
  console.log(`20 calls on one observation: ${Date.now() - started} ms`);
  const overview = await live.read(window, ["image"]);
  expect((await live.insert(`computer:observation/${overview.details.observation_id}?delivery=foreground`, { action: "click", x: 900, y: 700 })).details.status).toBe("delivered");
  await live.powershell(`Add-Type 'using System;using System.Runtime.InteropServices;public static class W{[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);}'; $h=(Get-Process -Id ${pid}).MainWindowHandle; [W]::MoveWindow($h,200,150,1800,1300,$true) | Out-Null`);
  const expired = await live.insert(`computer:observation/${overview.details.observation_id}?delivery=foreground`, { action: "click", x: 900, y: 700 });
  expect(expired.details.status).toBe("refused");
  expect(text(expired)).toMatch(/resized from/);
});

test("cancelling a long program stops between steps and reports the completed prefix", async () => {
  const view = await live.read(window, ["image"]);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 3000);
  const done = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`,
    { action: "sequence", sequence: Array.from({ length: 300 }, (_, i) => stroke(i)) }, abort.signal);
  const sequence = done.details.state!.sequence as { completed: number; attempted: number; stop_reason: string };
  console.log("cancelled:", done.details.status, JSON.stringify({ completed: sequence.completed, attempted: sequence.attempted, stop: sequence.stop_reason }));
  expect(sequence.completed).toBeGreaterThan(0);
  expect(sequence.completed).toBeLessThan(300);
  // No button stays held: a following pixel click is an ordinary complete click.
  const after = await live.read(window, ["image"]);
  expect((await live.insert(`computer:observation/${after.details.observation_id}?delivery=foreground`, { action: "click", x: 900, y: 700 })).details.status).toBe("delivered");
});
