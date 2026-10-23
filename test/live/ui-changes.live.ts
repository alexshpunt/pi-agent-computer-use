import { afterAll, expect, test } from "vitest";
import { connectLive, text } from "./remote.ts";
import { presentComputerResult } from "../../src/provider.ts";

// LPT-837: a changes Read of a new Paint document costs a fraction of a full UI Read and lists only what changed.
const live = await connectLive();
const opened: number[] = [];
afterAll(async () => { for (const pid of opened) await live.kill(pid); await live.close(); });

test("a changes re-read lists only the changed rows and their hints ground input", async () => {
  const paint = await live.insert(live.machine, { action: "open", app: "Paint" });
  expect(paint.details.status, text(paint)).toBe("observed");
  opened.push(paint.details.target!.pid);
  const window = `computer:window/${paint.details.window_ref}`;

  const full = await live.read(window, ["ui"]);
  const fullText = presentComputerResult(full);
  const unchanged = await live.read(window, ["changes"]);
  const unchangedText = presentComputerResult(unchanged);
  console.log(`full ${fullText.length} chars, ${full.details.ui!.elements.length} elements; unchanged re-read ${unchangedText.length} chars`);
  console.log(unchangedText);
  expect(unchanged.details.changes?.since).toBe(full.details.observation_id);
  // Only the fixed header and one change-count line remain; no element rows.
  expect(unchangedText).not.toMatch(/^\d+:[a-z]+ \| /m);
  expect(unchangedText.length).toBeLessThan(fullText.length / 5);

  const eraser = unchanged.details.ui!.elements.find(e => e.role === "Button" && e.name === "Eraser")!;
  const clicked = await live.insert(`computer:observation/${unchanged.details.observation_id}?hint=${encodeURIComponent(eraser.hint)}`, { action: "click" });
  expect(clicked.details.status, text(clicked)).toBe("delivered");

  const after = await live.read(window, ["changes"]);
  const afterText = presentComputerResult(after);
  console.log(afterText);
  const listed = after.details.changes!.diff!.changed.find(line => line.includes("\"Eraser\""));
  expect(listed, afterText).toBeTruthy();
  expect(after.details.changes!.diff!.counts.changed + after.details.changes!.diff!.counts.added).toBeLessThan(10);

  // The hint at the start of a listed row belongs to the new observation and grounds input.
  const hint = listed!.split(" ")[0];
  const pencil = after.details.ui!.elements.find(e => e.hint === hint)!;
  expect(pencil.name).toBe("Eraser");
  const again = await live.insert(`computer:observation/${after.details.observation_id}?hint=${encodeURIComponent(hint)}`, { action: "click" });
  expect(again.details.status, text(again)).toBe("delivered");
});
