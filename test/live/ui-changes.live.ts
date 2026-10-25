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
  expect(unchangedText).not.toMatch(/^[0-9a-z]+:[a-z]+ \| /m);
  expect(unchangedText.length).toBeLessThan(fullText.length / 5);

  const eraser = unchanged.details.ui!.elements.find(e => e.role === "Button" && e.name === "Eraser")!;
  const clicked = await live.insert(`computer:observation/${unchanged.details.observation_id}?hint=${encodeURIComponent(eraser.hint)}`, { action: "click" });
  expect(clicked.details.status, text(clicked)).toBe("delivered");

  // The click itself reports what changed (LPT-914), and its successor is now the window's latest observation.
  const clickedText = presentComputerResult(clicked);
  console.log(clickedText);
  const diff = clicked.details.successor!.diff!;
  const listed = diff.changed.find(line => line.includes("\"Eraser\""));
  expect(listed, clickedText).toBeTruthy();
  expect(diff.counts.changed + diff.counts.added).toBeLessThan(10);
  // The hint at the start of a listed row belongs to the successor observation, which is current for input.
  const hint = listed!.split(" ")[0];
  const successorId = clicked.details.successor!.observation_id!;
  const successor = await live.read(`computer:observation/${successorId}`, ["ui"]);
  expect(successor.details.ui!.elements.find(e => e.hint === hint)!.name).toBe("Eraser");
  const again = await live.insert(`computer:observation/${successorId}?hint=${encodeURIComponent(hint)}`, { action: "click" });
  expect(again.details.status, text(again)).toBe("delivered");

  // A changes Read after an action compares with that action's successor, so a repeated click shows no change.
  const after = await live.read(window, ["changes"]);
  expect(after.details.changes!.since).toBe(again.details.successor!.observation_id);
  expect(presentComputerResult(after)).toMatch(/Nothing changed in the UI since that observation\./);
});
