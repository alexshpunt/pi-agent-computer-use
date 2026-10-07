import { expect, test } from "vitest";
import { collectSequence, SequenceStore, selectFrames, validateSequence } from "../src/temporal-capture.ts";
import { observationSource } from "../src/observation-source.ts";

const source = observationSource("window", { screenshot_width: 10, screenshot_height: 10, window_bounds: { x: 0, y: 0, width: 10, height: 10 } }, { window_ref: "test-window" });
const frame = (data = "YQ==") => ({ image: { type: "image" as const, mimeType: "image/png", data }, source });
function clock() { let time = 0; return { now: () => time, wait: async (ms: number) => { time += ms; }, advance: (ms: number) => { time += ms; } }; }

test("slow captures skip elapsed slots instead of bursting or inventing timestamps", async () => {
  const c = clock(); const starts: number[] = [];
  const sequence = await collectSequence({ duration_ms: 1000, fps: 10 }, async () => {
    starts.push(c.now()); c.advance(240); return frame();
  }, undefined, c);
  expect(starts).toEqual([0, 300, 600, 900]);
  expect(sequence.frames.map(f => f.timestamp_ms)).toEqual([240, 540, 840, 1140]);
  expect(sequence.skipped_slots).toEqual([1, 2, 4, 5, 7, 8]);
  expect(sequence.sample_span_ms).toBe(900); expect(sequence.actual_fps).toBeCloseTo(1000 / 300);
  expect(sequence.elapsed_ms).toBe(1140); expect(sequence.payload_bytes).toBe(4);
  expect(sequence.frames.every(f => f.capture_latency_ms === 240)).toBe(true);
});

test("cancellation stops sampling and retains only the known completed prefix", async () => {
  const c = clock(); const controller = new AbortController(); let calls = 0;
  const sequence = await collectSequence({ duration_ms: 1000, fps: 10 }, async () => {
    calls++; c.advance(10); if (calls === 2) controller.abort(); return frame();
  }, controller.signal, c);
  expect(calls).toBe(2); expect(sequence.stop_reason).toBe("cancelled");
  expect(sequence.frames).toHaveLength(1); expect(sequence.pending_slots).toBe(9);
});

test("bounds fail before sampling and a frame limit reports unsampled slots", async () => {
  for (const input of [{ duration_ms: 0 }, { duration_ms: 10001 }, { fps: 11 }, { max_frames: 41 }, { timeout_ms: 10 }])
    expect(() => validateSequence({ duration_ms: 1000, ...input })).toThrow();
  const sequence = await collectSequence({ duration_ms: 1000, fps: 10, max_frames: 2 }, async () => frame(), undefined, clock());
  expect(sequence.frames).toHaveLength(2); expect(sequence.stop_reason).toBe("frame_limit"); expect(sequence.pending_slots).toBe(8);
});

test("selection keeps temporal order and compares bytes, not semantic claims", async () => {
  let count = 0;
  const sequence = await collectSequence({ duration_ms: 1000, fps: 4 }, async () => frame(++count < 3 ? "YQ==" : "Yg=="), undefined, clock());
  expect(selectFrames(sequence, "changed").map(f => f.index)).toEqual([0, 2]);
  expect(selectFrames(sequence, "endpoints").map(f => f.index)).toEqual([0, 3]);
  expect(selectFrames(sequence, { indexes: [3, 1] }).map(f => f.index)).toEqual([1, 3]);
  expect(selectFrames(sequence, { from: 1, to: 2 }).map(f => f.index)).toEqual([1, 2]);
  expect(() => selectFrames(sequence, { indexes: [4] })).toThrow();
  const store = new SequenceStore(); store.put(sequence);
  expect(store.get(sequence.sequence_id)).toBe(sequence);
  for (let i = 0; i < 3; i++) store.put({ ...sequence, sequence_id: `other-${i}` });
  expect(store.get(sequence.sequence_id)).toBeUndefined(); store.clear(); expect(store.get("other-2")).toBeUndefined();
});
