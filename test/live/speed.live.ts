import { afterEach, beforeEach, expect, test } from "vitest";
import { connectLive, text } from "./remote.ts";

const live = await connectLive();
let window = "", pid = 0;
beforeEach(async () => {
  const opened = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(opened.details.status, text(opened)).toBe("observed");
  window = `computer:window/${opened.details.window_ref}`;
  pid = opened.details.target!.pid;
  // Each check owns a fresh session and makes its own Paint window the initial foreground.
  // A previous sequence otherwise returns focus to the human window, which can cover the next check's points.
  for (const command of [
    { action: "resize", width: 1400, height: 1000, unit: "windows_desktop_pixels" },
    { action: "move", x: 60, y: 60, unit: "windows_desktop_pixels" },
    { action: "focus" },
  ]) {
    const placed = await live.resources.manageWindow(live.resources.address(window), live.cwd, command);
    expect(placed.details.status, text(placed)).toBe("delivered");
  }
});
afterEach(async () => { if (pid) await live.kill(pid); pid = 0; await live.close(); });

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

test("successor observations keep pixel coordinates for 20 calls and expire on resize", async () => {
  const view = await live.read(window, ["image"]);
  let observation = `computer:observation/${view.details.observation_id}?delivery=foreground`;
  const started = Date.now();
  for (let i = 0; i < 20; i++) {
    // Each receipt supplies the next observation in the same window-image coordinate space.
    const done = await live.insert(observation, { action: "drag", from_x: 300 + i * 20, from_y: 600, via: [{ x: 305 + i * 20, y: 620 }], to_x: 310 + i * 20, to_y: 640, duration_ms: 40 });
    expect(done.details.status, text(done)).toBe("delivered");
    expect(done.details.successor?.observation_id).toBeTruthy();
    observation = `computer:observation/${done.details.successor!.observation_id}?delivery=foreground`;
  }
  console.log(`20 calls with successors: ${Date.now() - started} ms`);
  const overview = await live.read(window, ["image"]);
  const click = await live.insert(`computer:observation/${overview.details.observation_id}?delivery=foreground`, { action: "click", x: 900, y: 700 });
  expect(click.details.status, text(click)).toBe("delivered");
  expect(click.details.successor?.observation_id).toBeTruthy();
  // Resize outside the provider so CUA must reject the capture before sending the click.
  await live.powershell(`Add-Type 'using System;using System.Runtime.InteropServices;public static class W{[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr v);[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);}'; if (-not [W]::SetProcessDpiAwarenessContext([IntPtr]-4)) { throw "DPI awareness was not set" }; $h=(Get-Process -Id ${pid}).MainWindowHandle; if (-not [W]::MoveWindow($h,100,100,1300,900,$true)) { throw "Resize failed" }`);
  const expired = await live.insert(`computer:observation/${click.details.successor!.observation_id}?delivery=foreground`, { action: "click", x: 900, y: 700 });
  expect(expired.details.status, text(expired)).toBe("refused");
  expect(expired.details.state, text(expired)).toMatchObject({ code: "capture_frame_mismatch", effect: "refused" });
  const resized = await live.read(window, ["image"]);
  const before = overview.details.state!.window_bounds as { width: number; height: number };
  const after = resized.details.state!.window_bounds as { width: number; height: number };
  expect([after.width, after.height]).not.toEqual([before.width, before.height]);
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
  const click = await live.insert(`computer:observation/${after.details.observation_id}?delivery=foreground`, { action: "click", x: 900, y: 700 });
  expect(click.details.status, text(click)).toBe("delivered");
});
