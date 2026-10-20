import { afterAll, beforeAll, expect, test } from "vitest";
import { performance } from "node:perf_hooks";
import sharp from "sharp";
import { connectLive, serveFixture, text } from "./remote.ts";
import { VisualClassifier, loadClassifierConfig } from "../../src/visual-classifier.ts";

// LPT-702: which capture/classification schedule catches a short-lived target best. The page shows a red square for
// FLASH_MS at a random spot every 1.5 s and journals appearances, hits (with reaction time) and misses. Detection is
// TinyCLIP over a 4x4 grid of the 640 px overview (threshold calibrated on this page); the click goes to the red
// pixels inside the chosen cell. Every schedule clicks through the latest observation, which a newer Read replaces.
const FLASH_MS = Number(process.env.FLASH_MS ?? 600);
const RUN_MS = Number(process.env.RUN_MS ?? 30_000);
const CHROME_PX = 60;
// The visible agent cursor glides to each new point before a click, which takes most of a second; reactive animation
// shortens that glide to 1 ms. REACTIVE=0 measures the ordinary glide.
const REACTIVE = process.env.REACTIVE !== "0";
const live = await connectLive();
const fixture = await serveFixture(live.runner);
const classifier = new VisualClassifier(await loadClassifierConfig(process.cwd()));
let window = "";
const results: Record<string, unknown>[] = [];

interface Frame { at: number; observation: string; data: string; mimeType: string }
const capture = async (): Promise<Frame> => {
  const view = await live.read(window, ['capture:{"granularity":"image","maxLongEdge":640}']);
  const image = view.content.find(block => block.type === "image") as { data: string; mimeType: string };
  return { at: performance.now(), observation: view.details.observation_id!, data: image.data, mimeType: image.mimeType };
};
/** Where to click in a frame, or undefined when TinyCLIP finds no red square. */
const detect = async (frame: Frame) => {
  const raw = Buffer.from(frame.data, "base64");
  const { width, height } = await sharp(raw).metadata();
  const cw = Math.floor(width! / 4), ch = Math.floor(height! / 4);
  const regions = Array.from({ length: 16 }, (_, k) => ({ x: (k % 4) * cw, y: Math.floor(k / 4) * ch, width: cw, height: ch }));
  const scores = (await classifier.classify({ image: { type: "image", data: frame.data, mimeType: frame.mimeType }, regions, condition: "a red square", threshold: 0.24 })).results.map(r => r.score);
  const best = scores.indexOf(Math.max(...scores));
  if (scores[best] < 0.24) return undefined;
  const cell = regions[best];
  const { data, info } = await sharp(raw).extract({ left: cell.x, top: cell.y, width: cell.width, height: cell.height }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, sx = 0, sy = 0;
  for (let p = 0; p < data.length; p += 3) {
    const q = p / 3, y = cell.y + Math.floor(q / info.width);
    // The top of the overview is Edge's own toolbar, which has red icons of its own.
    if (y >= CHROME_PX && data[p] > 150 && data[p] - data[p + 1] > 100 && data[p] - data[p + 2] > 100) { sx += q % info.width; sy += Math.floor(q / info.width); n++; }
  }
  return n < 20 ? undefined : { x: cell.x + Math.round(sx / n), y: cell.y + Math.round(sy / n) };
};

/** Run one schedule for RUN_MS and report what the page saw. */
async function measure(name: string, run: (deadline: number, stats: Stats) => Promise<void>) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  const before = (await fixture.journal()).length;
  const stats: Stats = { captured: 0, classified: 0, skipped: 0, clicks: 0, staleness: [], clickMs: [], lastClick: 0 };
  await run(performance.now() + RUN_MS, stats);
  await new Promise(resolve => setTimeout(resolve, 800));
  const events = (await fixture.journal()).slice(before).filter(e => e.page === "/flash");
  const reactions = events.filter(e => e.type === "hit").map(e => Number(e.reaction_ms)).sort((a, b) => a - b);
  const median = (values: number[]) => values.length ? Math.round([...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]) : null;
  const row = { schedule: name, shown: events.filter(e => e.type === "shown").length, hits: reactions.length, misses: events.filter(e => e.type === "miss").length,
    reaction_ms_p50: median(reactions), captured: stats.captured, classified: stats.classified, skipped: stats.skipped, clicks: stats.clicks, frame_age_at_click_ms_p50: median(stats.staleness), click_ms_p50: median(stats.clickMs),
    miss_detail: events.filter(e => e.type === "miss").slice(0, 4).map(e => ({ n: e.n, click: [Math.round(Number(e.x)), Math.round(Number(e.y))], square: e.square })) };
  console.log("SCHEDULE", JSON.stringify(row));
  results.push(row);
  return row;
}
interface Stats { captured: number; classified: number; skipped: number; clicks: number; staleness: number[]; clickMs: number[]; lastClick: number }

/** Click a detection unless a click was sent after this frame was captured (that appearance is already handled). */
async function act(frame: Frame, at: { x: number; y: number }, observation: string, stats: Stats) {
  if (frame.at <= stats.lastClick) return;
  stats.staleness.push(performance.now() - frame.at);
  const sent = performance.now();
  const click = await live.insert(`computer:observation/${observation}?delivery=foreground`, { action: "click", ...at, ...(REACTIVE ? { animation: "reactive" } : {}) });
  expect(click.details.status, text(click)).toBe("delivered");
  stats.clickMs.push(performance.now() - sent);
  stats.clicks++; stats.lastClick = performance.now();
}

beforeAll(async () => {
  const opened = await live.insert(live.machine, { action: "open_browser", browser: "msedge", url: `${fixture.base}/flash?ms=${FLASH_MS}` });
  expect(opened.details.status, text(opened)).toBe("observed");
  window = `computer:window/${opened.details.window_ref}`;
  await detect(await capture()); // Warm the classifier model before timing anything.
});
afterAll(async () => {
  console.log(`RESULTS flash ${FLASH_MS} ms, reactive ${REACTIVE}\n` + results.map(row => JSON.stringify(row)).join("\n"));
  await classifier.close(); await live.close(); fixture.close();
});

test("serial: capture, classify, act", async () => {
  const row = await measure("serial", async (deadline, stats) => {
    while (performance.now() < deadline) {
      const frame = await capture(); stats.captured++;
      const at = await detect(frame); stats.classified++;
      if (at) await act(frame, at, frame.observation, stats);
    }
  });
  // With the 1 ms glide a 600 ms target is caught most of the time (about 70% on ZinPC).
  if (REACTIVE && FLASH_MS >= 600) expect(row.hits).toBeGreaterThanOrEqual(row.shown / 3);
});

test("burst: five captures, then classify all and act on the newest hit", async () => {
  await measure("burst5", async (deadline, stats) => {
    while (performance.now() < deadline) {
      const frames: Frame[] = [];
      for (let i = 0; i < 5; i++) { frames.push(await capture()); stats.captured++; }
      let hit: { frame: Frame; at: { x: number; y: number } } | undefined;
      for (const frame of frames) { const at = await detect(frame); stats.classified++; if (at) hit = { frame, at }; }
      if (hit) await act(hit.frame, hit.at, frames.at(-1)!.observation, stats);
    }
  });
});

/** Captures run continuously; the classifier takes the newest waiting frame or every frame in order. */
async function pipelined(deadline: number, stats: Stats, newestOnly: boolean) {
  const waiting: Frame[] = [];
  let latest = "", done = false, clicking: Promise<void> = Promise.resolve(), inFlight: Promise<unknown> = Promise.resolve();
  const capturing = (async () => {
    while (performance.now() < deadline) {
      // A Read replaces the window's observation, so no capture may run while a click uses the latest one.
      await clicking;
      const next = capture(); inFlight = next;
      const frame = await next; stats.captured++; latest = frame.observation;
      waiting.push(frame);
      // A bounded queue: the oldest waiting frame is dropped when eight are queued.
      if (waiting.length > 8) { waiting.shift(); stats.skipped++; }
    }
    done = true;
  })();
  while (!done || waiting.length) {
    if (!waiting.length) { await new Promise(resolve => setTimeout(resolve, 5)); continue; }
    const taken = newestOnly ? waiting.splice(0) : [waiting.shift()!];
    stats.skipped += taken.length - 1;
    const frame = taken.at(-1)!;
    const at = await detect(frame); stats.classified++;
    if (at && performance.now() < deadline) {
      let release!: () => void;
      clicking = new Promise(resolve => { release = resolve; });
      await inFlight.catch(() => undefined);
      try { await act(frame, at, latest, stats); } finally { release(); }
    }
  }
  await capturing;
}

test("pipelined, newest frame only", async () => {
  await measure("newest-only", (deadline, stats) => pipelined(deadline, stats, true));
});

test("pipelined, every frame in order", async () => {
  await measure("every-frame", (deadline, stats) => pipelined(deadline, stats, false));
});

/** Whether the page's bottom-left block, which flips on every click, is dark in a frame. */
async function blockDark(frame: Frame) {
  const raw = Buffer.from(frame.data, "base64");
  const { height } = await sharp(raw).metadata();
  const { data } = await sharp(raw).extract({ left: 8, top: height! - 16, width: 4, height: 4 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[0] < 128;
}

/** Time from a delivered click until a returned frame shows its effect, capturing back to back. */
async function clickToFrame(rounds: number) {
  const latencies: number[] = [], frames: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const view = await capture();
    const before = await blockDark(view);
    // An empty spot below the toolbar; the square may be elsewhere, a click on it would also flip the block.
    await live.insert(`computer:observation/${view.observation}?delivery=foreground`, { action: "click", x: 20, y: 100 });
    const clicked = performance.now();
    let n = 0;
    while (performance.now() - clicked < 5000) {
      const frame = await capture(); n++;
      if (await blockDark(frame) !== before) { latencies.push(Math.round(frame.at - clicked)); frames.push(n); break; }
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return { rounds, seen: latencies.length, p50_ms: sorted[Math.floor(sorted.length / 2)], max_ms: sorted.at(-1), frames_until_seen: frames };
}

test("time from a click until a frame shows it", async () => {
  const result = await clickToFrame(15);
  console.log("CLICK_TO_FRAME", JSON.stringify(result));
  results.push({ schedule: "click to frame", ...result });
});
test("parallel captures of one window", async () => {
  const time = async (parallel: boolean) => {
    const started = performance.now();
    if (parallel) await Promise.all(Array.from({ length: 4 }, () => capture()));
    else for (let i = 0; i < 4; i++) await capture();
    return Math.round(performance.now() - started);
  };
  const serial = [await time(false), await time(false), await time(false)];
  const parallel = [await time(true), await time(true), await time(true)];
  console.log("CAPTURE4", JSON.stringify({ serial_ms: serial, parallel_ms: parallel }));
  results.push({ schedule: "4 captures", serial_ms: serial, parallel_ms: parallel });
});
