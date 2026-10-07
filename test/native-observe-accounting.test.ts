import { expect, test } from "vitest";
import { accountNativeTrace, summarizeNativeSamples } from "../scripts/native-observe-accounting.ts";

const trace = { schema: 1, request: 1, total_us: 100, concurrent: false, truncated: false, events: [
  { name: "owner", start_us: 10, duration_us: 80 },
  { name: "worker", start_us: 20, duration_us: 40 },
  { name: "leaf", start_us: 30, duration_us: 10 },
  { name: "leaf", start_us: 50, duration_us: 10 },
] };
test("nested and repeated spans account for each native microsecond exactly once", () => {
  expect(accountNativeTrace(trace)).toEqual({ exclusive_us: { unattributed: 20, owner: 40, worker: 20, leaf: 20 },
    inclusive_us: { owner: 80, worker: 40, leaf: 20 }, calls: { owner: 1, worker: 1, leaf: 2 } });
});
test("concurrent, truncated, non-finite and out-of-request evidence cannot support attribution", () => {
  for (const bad of [ { ...trace, concurrent: true }, { ...trace, truncated: true },
    { ...trace, total_us: NaN }, { ...trace, events: [{ name: "leaf", start_us: 95, duration_us: 10 }] } ])
    expect(() => accountNativeTrace(bad)).toThrow();
});
test("partial overlap is partitioned without adding its shared time twice", () => {
  const r = accountNativeTrace({ ...trace, events: [ { name: "first", start_us: 0, duration_us: 60 }, { name: "second", start_us: 40, duration_us: 60 } ] });
  expect(Object.values(r.exclusive_us).reduce((a,b)=>a+b,0)).toBe(100);
  expect(Object.values(r.inclusive_us).reduce((a,b)=>a+b,0)).toBe(120);
});
test("paired summary excludes setup and uses additive means, not sums of medians", () => {
  const diagnostic = { mode: "image", phase: "warm", runtime: "diagnostic", rpc_ms: 0.2, trace, accounting: accountNativeTrace(trace) };
  const [summary] = summarizeNativeSamples([diagnostic, { ...diagnostic, phase: "setup", rpc_ms: 1000 },
    { mode: "image", phase: "warm", runtime: "installed", rpc_ms: 0.15 }]);
  expect(summary.count).toBe(1);
  expect(summary.installed.mean_ms).toBe(0.15);
  expect(summary.diagnostic.client_remainder_mean_ms).toBeCloseTo(0.1);
  expect(Object.values(summary.diagnostic.stages).reduce((a,b)=>(a??0)+(b??0),0)).toBeCloseTo(0.1);
});
