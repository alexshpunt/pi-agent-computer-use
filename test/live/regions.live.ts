import { afterAll, expect, test } from "vitest";
import { connectLive, text } from "./remote.ts";
import { presentComputerResult } from "../../src/provider.ts";

// LPT-836: Cua perception finds Paint's toolbar icons, and a detected icon's center grounds a pixel click.
// The Eraser button's UI Automation bounds are the reference for where its icon is.
const live = await connectLive();
const opened: number[] = [];
afterAll(async () => { for (const pid of opened) await live.kill(pid); await live.close(); });

test("a detected toolbar icon is clicked by its center and selects that tool", async () => {
  const paint = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(paint.details.status, text(paint)).toBe("observed");
  opened.push(paint.details.target!.pid);
  const window = `computer:window/${paint.details.window_ref}`;

  const started = performance.now();
  const view = await live.read(window, ["regions"]);
  console.log(`regions in ${Math.round(performance.now() - started)} ms`);
  const shown = presentComputerResult(live.resources, view);
  console.log(shown.split("\n").filter(line => line.startsWith("Regions") || line.startsWith("icon")).slice(0, 25).join("\n"));
  const regions = view.details.visual_regions!;
  expect(regions.filter(r => r.kind === "icon").length).toBeGreaterThan(5);

  const eraser = view.details.ui!.elements.find(e => e.role === "Button" && e.name === "Eraser")!.bounds.window_image!;
  const inside = (x: number, y: number) => x >= eraser.x && x <= eraser.x + eraser.width && y >= eraser.y && y <= eraser.y + eraser.height;
  const icon = regions.find(r => r.kind === "icon" && inside(r.x + r.width / 2, r.y + r.height / 2));
  expect(icon, `Eraser ${JSON.stringify(eraser)}`).toBeTruthy();

  const center = { x: Math.round(icon!.x + icon!.width / 2), y: Math.round(icon!.y + icon!.height / 2) };
  const clicked = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, { action: "click", ...center });
  expect(clicked.details.status, text(clicked)).toBe("delivered");
  const after = await live.read(window, ["ui"]);
  expect(after.details.ui!.elements.find(e => e.role === "Button" && e.name === "Eraser")!.selected).toBe(true);
});
