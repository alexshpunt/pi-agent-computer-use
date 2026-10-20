import { afterAll, expect, test } from "vitest";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { connectLive, serveFixture, text } from "./remote.ts";
import type { ComputerResult } from "../../src/session.ts";

// LPT-810: frame stream rate and age for a 1280 px window, and a capture→find→click loop against a moving target.
// The page itself measures reaction time from the target's move to the click it receives.
const live = await connectLive();
const fixture = await serveFixture(live.runner);
let window = "";
afterAll(async () => { await live.close(); fixture.close(); });

test("a sequence reports achieved FPS and frame age for a 1280 px window", async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", browser: "msedge", url: `${fixture.base}/target` });
  expect(opened.details.status, text(opened)).toBe("observed");
  window = `computer:window/${opened.details.window_ref}`;
  const read = await live.read(window, ['sequence:{"duration_ms":3000,"fps":30,"max_frames":90,"maxLongEdge":1280}']);
  const sequence = read.details.sequence!;
  console.log("stream", { frames: sequence.frames.length, actual_fps: sequence.actual_fps, last_frame_age_ms: sequence.last_frame_age_ms, interval_ms: sequence.interval_ms, stop: sequence.stop_reason });
  expect(sequence.frames.length).toBeGreaterThan(1);
  expect(sequence.actual_fps).toBeGreaterThan(0);
  expect(sequence.last_frame_age_ms).not.toBeNull();
});

test("a capture, find and click loop hits a moving target and the page reports reaction times", async () => {
  const before = (await fixture.journal()).length;
  const loops: number[] = [];
  const deadline = performance.now() + 15_000;
  let lastHit = { x: -1, y: -1 };
  while (performance.now() < deadline && loops.length < 40) {
    const started = performance.now();
    const view: ComputerResult = await live.read(window, ['capture:{"granularity":"image","maxLongEdge":640}']);
    const image = view.content.find(block => block.type === "image") as { data: string };
    const { data, info } = await sharp(Buffer.from(image.data, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < data.length; i += 3) if (data[i] > 200 && data[i + 1] < 40 && data[i + 2] < 60) { const p = i / 3; sx += p % info.width; sy += Math.floor(p / info.width); n++; }
    if (n < 20) continue;
    const at = { x: Math.round(sx / n), y: Math.round(sy / n) };
    if (Math.abs(at.x - lastHit.x) + Math.abs(at.y - lastHit.y) < 4) continue; // Already clicked this position.
    const click = await live.insert(`computer:observation/${view.details.observation_id}?delivery=foreground`, { action: "click", ...at });
    expect(click.details.status, text(click)).toBe("delivered");
    lastHit = at;
    loops.push(performance.now() - started);
  }
  await new Promise(resolve => setTimeout(resolve, 500));
  const hits = (await fixture.journal()).slice(before).filter(e => e.type === "hit").map(e => Number(e.reaction_ms));
  const sorted = [...hits].sort((a, b) => a - b);
  console.log("reaction", { clicks: loops.length, hits: hits.length, loop_ms_p50: Math.round([...loops].sort((a, b) => a - b)[Math.floor(loops.length / 2)]), reaction_ms_p50: sorted[Math.floor(sorted.length / 2)], reaction_ms_max: sorted.at(-1) });
  expect(hits.length).toBeGreaterThanOrEqual(5);
});
