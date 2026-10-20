import { afterAll, expect, test } from "vitest";
import sharp from "sharp";
import { connectLive, text } from "./remote.ts";
import type { ComputerResult } from "../../src/session.ts";

// LPT-809: synthetic pen pressure reaches a pressure-aware app. GIMP (user install, GIMP_PATH on the machine)
// draws with its default Paintbrush and "Pressure Size" dynamics; a stroke with rising pressure must widen,
// while a constant-pressure stroke keeps its width. Paint 11 ignores synthetic pressure, so it is not used here.
const live = await connectLive();
const gimp = process.env.GIMP_PATH ?? "C:\\Users\\user\\AppData\\Local\\Programs\\GIMP 3\\bin\\gimp-3.2.exe";
let pid = 0;
afterAll(async () => { if (pid) await live.kill(pid); await live.close(); });

test("a pen stroke with rising pressure gets thicker in GIMP", async () => {
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#ffffff" } }).png().toFile(".tmp/pen-canvas.png");
  const put = await live.insert(live.machine, { action: "put", from: ".tmp/pen-canvas.png" });
  await live.insert(live.machine, { action: "open", path: gimp, args: [put.details.state!.path as string] });
  // GIMP may also show its Welcome dialog, so find the image window by its title rather than trusting a single new window.
  let main: { window_ref: string; pid: number } | undefined;
  for (let attempt = 0; attempt < 30 && !main; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const rows = ((await live.search(live.windows, "regex:pen-canvas.*GIMP$") as ComputerResult).details.state?.windows ?? []) as { window_ref?: string; pid: number }[];
    main = rows.find(row => row.window_ref) as typeof main;
  }
  expect(main).toBeTruthy();
  pid = main!.pid;
  const welcome = ((await live.search(live.windows, "regex:^Welcome to GIMP") as ComputerResult).details.state?.windows ?? []) as { window_ref?: string }[];
  if (welcome[0]?.window_ref) await live.insert(`computer:window/${welcome[0].window_ref}`, { action: "kill" }).catch(() => undefined);
  const window = `computer:window/${main!.window_ref}`;
  const view = await live.read(window, ["image"]);
  const { width, height } = (view.details.agent_image as { output: { width: number; height: number } }).output;
  // The image is centred in GIMP's canvas area; these lines stay inside it at any window size the app opens with.
  const x0 = Math.round(width * 0.3), x1 = Math.round(width * 0.68), rising = Math.round(height * 0.4), flat = Math.round(height * 0.62);
  const stroke = (y: number, pressure: (i: number) => number, start: number) => [
    { at_ms: start, type: "pen_down", x: x0, y, pressure: pressure(0) },
    ...Array.from({ length: 50 }, (_, i) => ({ at_ms: start + 20 + i * 16, type: "pen_move", x: x0 + Math.round((x1 - x0) * (i + 1) / 50), y, pressure: pressure(i + 1) })),
    { at_ms: start + 850, type: "pen_up", x: x1, y }];
  const drawn = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, { action: "timeline",
    events: [...stroke(rising, i => Math.round((0.05 + 0.95 * i / 50) * 100) / 100, 0), ...stroke(flat, () => 0.5, 1000)] });
  expect(drawn.details.status, text(drawn)).toBe("delivered");
  await new Promise(resolve => setTimeout(resolve, 1000));
  const after = await live.read(window, ["image"]);
  const png = Buffer.from((after.content.find(block => block.type === "image") as { data: string }).data, "base64");
  await sharp(png).extract({ left: x0 - 40, top: rising - 60, width: x1 - x0 + 80, height: flat - rising + 120 }).toFile(".tmp/pen-strokes.png");
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const widths = (y: number) => [0.1, 0.3, 0.5, 0.7, 0.9].map(f => {
    const x = Math.round(x0 + (x1 - x0) * f);
    let dark = 0;
    for (let dy = -60; dy <= 60; dy++) if (data[(y + dy) * info.width + x] < 128) dark++;
    return dark;
  });
  const up = widths(rising), level = widths(flat);
  console.log("stroke widths (px)", { rising: up, constant: level });
  expect(up.every((value, i) => i === 0 || value >= up[i - 1])).toBe(true);
  expect(up.at(-1)! - up[0]).toBeGreaterThanOrEqual(8);
  expect(Math.max(...level) - Math.min(...level)).toBeLessThanOrEqual(2);
});
