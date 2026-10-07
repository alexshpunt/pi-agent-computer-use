import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createTemporalSite } from "../test/fixtures/temporal-site.mjs";
import { openCompleteInputWindow } from "./complete-input-window.mjs";
import { loadComputerConfig } from "../src/config.ts";
import { McpDriver } from "../src/driver.ts";
import { ComputerSession } from "../src/session.ts";

// Opt-in live Windows check, using only a newly opened isolated browser on a synthetic local page.
// Keep it open for production computer_* verification; send finish to close this owned fixture.
const directory = `.tmp/lpt-616/live-${Date.now()}`; await mkdir(directory, { recursive: true });
const config = await loadComputerConfig(process.cwd()); const driver = new McpDriver(config);
const root = config.command.replace(/\/cua-driver-[^/]+\/cua-driver\.exe$/, "");
assert.ok(root.startsWith("/mnt/c/"));
const nativeRoot = root.replace("/mnt/c/", "C:\\").replaceAll("/", "\\");
const site = await createTemporalSite(); let fixture; const measurements = [];
try {
  fixture = await openCompleteInputWindow(driver, site.url, nativeRoot);
  console.log(JSON.stringify({ directory, title: "Pi temporal capture fixture", target: fixture.target, url: site.url }));
  const session = new ComputerSession(driver);
  const listed = await session.windows(undefined, "Pi temporal capture fixture");
  const windows = listed.details.state?.windows.filter(w => w.pid === fixture.target.pid && w.window_id === fixture.target.window_id);
  assert.equal(windows?.length, 1); const ref = windows[0].window_ref;
  for (const [kind, fps] of [["window", 4], ["window", 10], ["display", 4]]) {
    const capture = await session.captureSequence(kind === "window" ? { window_ref: ref } : { display: "primary" }, { duration_ms: 3000, fps });
    assert.equal(capture.details.status, "observed", capture.content[0].text);
    const seq = capture.details.sequence; assert.ok(seq.frames.length > 1); assert.equal(seq.stop_reason, "completed");
    assert.ok(capture.content.every(b => b.type === "text"));
    assert.ok(seq.frames.every((frame, i) => i === 0 || frame.timestamp_ms > seq.frames[i - 1].timestamp_ms));
    const selected = await session.sequenceFrames(seq.sequence_id, "endpoints");
    assert.equal(selected.content.filter(b => b.type === "image").length, 2);
    const latency = seq.frames.map(f => f.capture_latency_ms);
    const report = { kind, fps, count: seq.frames.length, actual_fps: seq.actual_fps, elapsed_ms: seq.elapsed_ms, sample_span_ms: seq.sample_span_ms,
      interval_ms: seq.interval_ms, native_latency_ms: { min: Math.min(...latency), max: Math.max(...latency), mean: latency.reduce((a, b) => a + b, 0) / latency.length },
      skipped: seq.skipped_slots, pending: seq.pending_slots, bytes: seq.payload_bytes, unique_hashes: new Set(seq.frames.map(f => f.hash)).size,
      timestamps: seq.frames.map(f => f.timestamp_ms), dimensions: seq.frames[0].source.image.dimensions };
    measurements.push(report); console.log(JSON.stringify(report));
  }
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 650);
  const cancelled = await session.captureSequence({ window_ref: ref }, { duration_ms: 5000, fps: 4 }, abort.signal); clearTimeout(timer);
  assert.equal(cancelled.details.sequence.stop_reason, "cancelled");
  await delay(400);
  const subsequent = await session.captureSequence({ window_ref: ref }, { duration_ms: 1 });
  assert.equal(subsequent.details.status, "observed");
  measurements.push({ cancellation: cancelled.details.sequence.stop_reason, prefix: cancelled.details.sequence.frames.length,
    returned_ms: cancelled.details.sequence.elapsed_ms, next_capture: subsequent.details.status });
  await writeFile(`${directory}/measurements.json`, JSON.stringify(measurements, null, 2));
  console.log("Fixture ready for production verification; send finish for owned-window cleanup.");
  const input = createInterface({ input: process.stdin });
  for await (const line of input) { if (line.trim() === "finish") break; } input.close();
} finally {
  const cleanup = await fixture?.close(); await driver.close(); await site.close();
  await writeFile(`${directory}/cleanup.json`, JSON.stringify({ cleanup }, null, 2));
  console.log(JSON.stringify({ directory, cleanup }));
}
