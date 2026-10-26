import { expect, test } from "vitest";
import { framesBetween, sheetFrames } from "../src/watch.ts";
import type { SequenceFrame } from "../src/temporal-capture.ts";

// Frames every 100 ms; `hashes` decides which differ from the one before.
const frames = (hashes: string[]) => hashes.map((hash, index) => ({ index, timestamp_ms: index * 100, hash, geometry_changed: false }) as SequenceFrame);

test("a watch's sheet shows every frame that changed and the last one", () => {
  const picked = sheetFrames(frames(["a", "a", "b", "b", "c", "c"]), []);
  expect(picked.map(frame => frame.index)).toEqual([0, 2, 4, 5]);
});

test("a sheet over its limit keeps the first, the last and the frames around each action, and spreads the rest", () => {
  // 100 frames that all differ; a drag from 3000 to 3500 ms.
  const all = frames(Array.from({ length: 100 }, (_, i) => String(i)));
  const picked = sheetFrames(all, [{ label: "drag", start_ms: 3000, end_ms: 3500 }], 10).map(frame => frame.index);
  expect(picked).toHaveLength(10);
  expect(picked).toEqual([...picked].sort((a, b) => a - b));
  for (const index of [0, 99, 30, 35, 36]) expect(picked).toContain(index);
});

test("an action's span names the frames captured during it, or none", () => {
  const all = frames(["a", "b", "c", "d", "e"]);
  expect(framesBetween(all, 150, 320)).toEqual({ from: 2, to: 3 });
  expect(framesBetween(all, 410, 450)).toBeNull();
});
