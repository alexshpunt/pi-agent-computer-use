import sharp from "sharp";
import { expect, test } from "vitest";
import { VisionTrace } from "../src/vision-trace.ts";

test("the viewer correlates every selected temporal frame but does not treat selection as forwarding", async () => {
  const trace = new VisionTrace("sequence");
  const images = await Promise.all(["red", "blue", "green", "yellow"].map(async background => ({ type: "image", mimeType: "image/png",
    data: (await sharp({ create: { width: 10, height: 10, channels: 3, background } }).png().toBuffer()).toString("base64") })));
  trace.startAction("capture", "computer_sequence", {});
  trace.finishAction("capture", [], { status: "observed", sequence: { sequence_id: "seq-one", frames: [{ index: 0 }] } }, false);
  expect(trace.snapshot().captures).toHaveLength(0);
  trace.startAction("select", "computer_sequence", { sequence_id: "seq-one", selection: "all" });
  trace.finishAction("select", images, { status: "observed", selected_frames: images.map((_, index) => ({ index, timestamp_ms: index * 250, source: { kind: "window" } })) }, false);
  expect(trace.snapshot().requests).toHaveLength(0);
  trace.startAction("repeat", "computer_sequence", { sequence_id: "seq-one", selection: "first" });
  trace.finishAction("repeat", [images[0]], { status: "observed", selected_frames: [{ index: 0, timestamp_ms: 0 }] }, false);
  trace.observePayload({ images }, { provider: "test", api: "test", model: "test" });
  const latest = trace.snapshot().requests.at(-1)!;
  expect(latest.sequenceImages).toHaveLength(4);
  expect(latest.sequenceImages.every(item => item.matches.length === 1)).toBe(true);
  expect(latest.sequenceImages.map(item => item.matches[0])).toEqual(images.map((_, index) => ({ sequence_id: "seq-one", index, timestamp_ms: index * 250 })));
  expect(latest.sequenceImages.every(item => !!trace.asset(item.hash))).toBe(true);
  expect(trace.snapshot().frames).toHaveLength(3);
  trace.startAction("same-pixels", "computer_sequence", { sequence_id: "seq-one", selection: "last" });
  trace.finishAction("same-pixels", [images[0]], { status: "observed", selected_frames: [{ index: 4, timestamp_ms: 1000 }] }, false);
  trace.observePayload({ images: [images[0]] }, { provider: "test", api: "test", model: "test" });
  expect(trace.snapshot().requests.at(-1)!.sequenceImages[0].matches.map(frame => frame.index)).toEqual([0, 4]);
});
