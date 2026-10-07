import assert from "node:assert/strict";

/** Redacted native timing envelope emitted after one sequential observation. */
export interface NativeTrace {
  schema: number; request: number; total_us: number; concurrent: boolean; truncated: boolean;
  events: { name: string; start_us: number; duration_us: number }[];
}
export interface NativeAccounting {
  exclusive_us: Record<string, number>; inclusive_us: Record<string, number>; calls: Record<string, number>;
}
interface Sample {
  mode: string; phase: string; runtime: string; rpc_ms: number; trace?: NativeTrace; accounting?: NativeAccounting;
}

/** Partition a native request's timeline once, giving overlapping time to the smallest active span.
 * Parent spans stay available in the raw evidence, but are never added to their children.
 */
export function accountNativeTrace(trace: NativeTrace) {
  assert.equal(trace.schema, 1);
  assert.equal(trace.concurrent, false, "Concurrent native requests cannot be attributed.");
  assert.equal(trace.truncated, false, "Incomplete native spans cannot be attributed.");
  assert.ok(Number.isSafeInteger(trace.request) && trace.request > 0);
  assert.ok(Number.isSafeInteger(trace.total_us) && trace.total_us > 0);
  assert.ok(Array.isArray(trace.events) && trace.events.length <= 256);
  const events = trace.events.map(event => {
    assert.ok(/^[a-zA-Z0-9_.]+$/.test(event.name), "Only fixed timing labels belong in evidence.");
    for (const key of ["start_us", "duration_us"] as const) assert.ok(Number.isSafeInteger(event[key]) && event[key] >= 0);
    const end = event.start_us + event.duration_us;
    // Integer microsecond rounding can put a child's endpoint one microsecond beyond its parent.
    assert.ok(end <= trace.total_us + 1, "Span lies outside the native request.");
    return { ...event, end: Math.min(end, trace.total_us) };
  });
  const boundaries = [...new Set([0, trace.total_us, ...events.flatMap(e => [Math.min(e.start_us, trace.total_us), e.end])])].sort((a,b) => a-b);
  const exclusive_us: Record<string, number> = Object.create(null);
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i-1], end = boundaries[i];
    const active = events.filter(e => e.start_us <= start && e.end >= end && e.duration_us > 0)
      .sort((a,b) => a.duration_us-b.duration_us || b.start_us-a.start_us || a.name.localeCompare(b.name));
    const label = active[0]?.name ?? "unattributed";
    exclusive_us[label] = (exclusive_us[label] ?? 0) + end-start;
  }
  assert.equal(Object.values(exclusive_us).reduce((a,b) => a+b, 0), trace.total_us);
  const inclusive_us: Record<string, number> = Object.create(null), calls: Record<string, number> = Object.create(null);
  for (const e of events) {
    inclusive_us[e.name] = (inclusive_us[e.name] ?? 0) + e.duration_us;
    calls[e.name] = (calls[e.name] ?? 0) + 1;
  }
  return { exclusive_us, inclusive_us, calls };
}

/** Arithmetic means are used for additive tables; medians are reported separately. */
export function summarizeNativeSamples(samples: Sample[]) {
  const mean = (rows: number[]) => rows.length ? rows.reduce((a,b)=>a+b,0)/rows.length : null;
  const median = (rows: number[]) => { const s=[...rows].sort((a,b)=>a-b); return s.length ? (s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2 : null; };
  return [...new Set(samples.map(s=>s.mode))].map(mode => {
    const rows = samples.filter(s=>s.mode===mode && s.phase==="warm");
    const diag = rows.filter((s): s is Sample & { trace: NativeTrace; accounting: NativeAccounting } => s.runtime==="diagnostic" && !!s.trace && !!s.accounting), baseline = rows.filter(s=>s.runtime==="installed");
    const labels = [...new Set(diag.flatMap(s=>Object.keys(s.accounting.exclusive_us)))];
    return { mode, count: diag.length, installed: { mean_ms: mean(baseline.map(s=>s.rpc_ms)), median_ms: median(baseline.map(s=>s.rpc_ms)) },
      diagnostic: { mean_ms: mean(diag.map(s=>s.rpc_ms)), median_ms: median(diag.map(s=>s.rpc_ms)), native_mean_ms: mean(diag.map(s=>s.trace.total_us/1000)),
        client_remainder_mean_ms: mean(diag.map(s=>s.rpc_ms-s.trace.total_us/1000)),
        stages: Object.fromEntries(labels.map(label=>[label, mean(diag.map(s=>(s.accounting.exclusive_us[label]??0)/1000))])) } };
  });
}
