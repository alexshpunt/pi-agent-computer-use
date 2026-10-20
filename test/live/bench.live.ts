import { afterAll, expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { McpDriver } from "../../src/driver.ts";
import { connectLive, text } from "./remote.ts";

// Per-stage latency of the observe→act loop on LIVE_MACHINE (zinpc, or local). Run:
//   LIVE_MACHINE=local npx vitest run --config vitest.live.config.ts test/live/bench.live.ts
// Stages: native capture (get_window_state), adapter work on that capture (Read minus native),
// transport (a trivial native call), native input (click) and the full Read+click loop.
// It acts only on a new Notepad window it opens and closes.
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 20);
// BENCH_EDGE sets the overview long edge.
const VIEWS = ["image",
  ...(process.env.BENCH_EDGE ? [`capture:{"maxLongEdge":${process.env.BENCH_EDGE}}`] : [])];
const native: { name: string; ms: number }[] = [];
const call = McpDriver.prototype.call;
McpDriver.prototype.call = async function (this: McpDriver, ...args: Parameters<typeof call>) {
  const started = performance.now();
  try { return await call.apply(this, args); }
  finally { native.push({ name: args[0], ms: performance.now() - started }); }
};
const live = await connectLive();
let hwnd = 0;
afterAll(async () => { if (hwnd) await live.closeWindow(hwnd); await live.close(); McpDriver.prototype.call = call; });

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
};
const timed = async <T>(work: () => Promise<T>) => {
  const mark = native.length, started = performance.now();
  const result = await work();
  return { result, ms: performance.now() - started, native: native.slice(mark) };
};
const nativeMs = (calls: { name: string; ms: number }[], name: string) => calls.filter(c => c.name === name).reduce((sum, c) => sum + c.ms, 0);

test("observe and act loop latency per stage", async () => {
  const opened = await live.insert(live.machine, { action: "open", app: "Notepad" });
  expect(opened.details.status, text(opened)).toBe("observed");
  hwnd = opened.details.target!.window_id;
  const window = `computer:window/${opened.details.window_ref}`;
  const stages: Record<string, number[]> = { "capture native": [], "capture adapter": [], "read total": [], "transport (control state)": [], "input native": [], "input total": [], "loop total": [] };
  for (let round = 0; round < ROUNDS; round++) {
    const read = await timed(() => live.read(window, VIEWS));
    expect(read.result.details.status, text(read.result)).toBe("observed");
    const capture = nativeMs(read.native, "get_window_state");
    stages["capture native"].push(capture);
    stages["capture adapter"].push(read.ms - read.native.reduce((sum, c) => sum + c.ms, 0));
    stages["read total"].push(read.ms);
    const { width, height } = (read.result.details.agent_image as { output: { width: number; height: number } }).output;
    const click = await timed(() => live.insert(`computer:observation/${read.result.details.observation_id}?delivery=foreground`, { action: "click", x: Math.round(width / 2), y: Math.round(height / 2) }));
    if (click.result.details.status !== "delivered") console.log("CLICK", JSON.stringify(click.result.details.state).slice(0, 800));
    expect(click.result.details.status, text(click.result)).toBe("delivered");
    stages["input native"].push(nativeMs(click.native, "click"));
    stages["input total"].push(click.ms);
    stages["loop total"].push(read.ms + click.ms);
    const state = await timed(() => live.read(window, ["state"]));
    stages["transport (control state)"].push(nativeMs(state.native, "get_window_control_state"));
  }
  const report = Object.entries(stages).map(([stage, values]) => ({ stage, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }));
  console.table(report);
  await mkdir(".tmp/m7", { recursive: true });
  await writeFile(`.tmp/m7/bench-${process.env.LIVE_MACHINE ?? "zinpc"}-${Date.now()}.json`, JSON.stringify({ machine: process.env.LIVE_MACHINE ?? "zinpc", rounds: ROUNDS, report, stages }, null, 1));
});
