import { mkdir, writeFile } from "node:fs/promises";
import { afterAll, expect, test } from "vitest";
import { connectLive, paintTool, text } from "./remote.ts";
import { presentComputerResult } from "../../src/provider.ts";

// LPT-915: an action on a canvas reports the changed area of the window's pixels with before/after crops.
const live = await connectLive();
const opened: number[] = [];
afterAll(async () => { for (const pid of opened) await live.kill(pid); await live.close(); });

test("a Paint stroke reports a box around it with crops, and a click on empty space reports no change", async () => {
  const paint = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(paint.details.status, text(paint)).toBe("observed");
  opened.push(paint.details.target!.pid);
  const window = `computer:window/${paint.details.window_ref}`;
  await paintTool(live, window, "Pencil");

  const view = await live.read(window, ["full"]);
  const canvas = view.details.ui!.elements.find(e => e.role === "Group" && /on Canvas$/.test(e.name ?? ""))!.bounds.window_image!;
  const from = { x: canvas.x + Math.round(canvas.width * 0.35), y: canvas.y + Math.round(canvas.height * 0.4) };
  const to = { x: from.x + 200, y: from.y + 60 };
  let started = performance.now();
  const stroke = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`,
    { action: "drag", from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y, duration_ms: 200 });
  const strokeMs = Math.round(performance.now() - started);
  const strokeText = presentComputerResult(stroke);
  console.log(`stroke ${strokeMs} ms\n${strokeText}`);
  expect(stroke.details.status, strokeText).toBe("delivered");
  const pixels = stroke.details.successor!.diff!.pixels!;
  // The largest changed area is the stroke; others, such as the Undo button turning on, are listed separately.
  const [area] = pixels.areas;
  expect(area.x).toBeLessThanOrEqual(from.x);
  expect(area.y).toBeLessThanOrEqual(from.y);
  expect(area.x + area.width).toBeGreaterThanOrEqual(to.x);
  expect(area.y + area.height).toBeGreaterThanOrEqual(to.y);
  expect(area.width).toBeLessThan(260);
  expect(pixels.share).toBeLessThan(0.05);
  // LPT-928: image 1 outlines the numbered areas on the window; the stroke ends at the input point, so it is area 1.
  expect(strokeText).toMatch(/Pixels changed in \d+ areas? .*image 1 outlines and numbers them on the window:\n  1\. x=\d+ y=\d+ w=\d+ h=\d+ \(at the input point\); images 2 and 3 show .* before and after/);
  const [overview, ...crops] = stroke.content.filter(block => block.type === "image") as { data: string }[];
  expect(crops.length).toBe(2 * pixels.crops!.length);
  await mkdir(".tmp/lpt915", { recursive: true });
  await writeFile(".tmp/lpt915/stroke-overview.png", Buffer.from(overview.data, "base64"));
  await Promise.all(crops.map((crop, i) => writeFile(`.tmp/lpt915/stroke-${Math.floor(i / 2) + 1}-${i % 2 ? "after" : "before"}.png`, Buffer.from(crop.data, "base64"))));

  // The strip between the ribbon and the canvas does nothing when clicked. Background delivery leaves the real
  // pointer alone, so Paint's status bar keeps showing the same pointer position.
  const empty = { x: canvas.x + Math.round(canvas.width / 3), y: canvas.y - 12 };
  started = performance.now();
  const click = await live.insert(`computer:observation/${stroke.details.successor!.observation_id}`, { action: "click", ...empty });
  const clickMs = Math.round(performance.now() - started);
  const clickText = presentComputerResult(click);
  console.log(`empty click ${clickMs} ms\n${clickText}`);
  expect(clickText).toMatch(/Nothing changed in the UI or the window's pixels within \d+ ms after the action\./);
  expect(click.content.some(block => block.type === "image")).toBe(false);
});
