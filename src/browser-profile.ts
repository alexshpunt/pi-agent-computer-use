/** Standalone profiler only. Never imported by the normal Pi tool registration. */
export interface ProfileChild {
  name: string; cold: boolean; start_ms: number; duration_ms: number; outcome: string;
}
/** Only timings and fixed operation labels are retained, never call arguments or result bodies. */
export interface ProfileSample {
  operation: string; phase: "cold" | "warm" | "setup" | "cleanup";
  duration_ms: number; child_ms: number; remaining_ms: number;
  status: string; verified: boolean; success: boolean; children: ProfileChild[];
}

/** Measure adapter calls and union their child intervals without double-counting nested work. */
export class BrowserProfile {
  readonly samples: ProfileSample[] = [];
  private active?: { start: number; sample: ProfileSample };
  private readonly seen = new Set<string>();
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }

  /** Record one native RPC, lifetime check or frame acknowledgement. Labels are supplied by the runner. */
  async child<T>(name: string, work: () => Promise<T>, outcome: (result: T) => string = () => "returned"): Promise<T> {
    const active = this.active;
    if (!active) return work();
    const start = this.now();
    const child: ProfileChild = { name, cold: !this.seen.has(name), start_ms: start - active.start, duration_ms: 0, outcome: "threw" };
    this.seen.add(name); active.sample.children.push(child);
    try {
      const result = await work();
      child.outcome = outcome(result);
      return result;
    } finally { child.duration_ms = this.now() - start; }
  }

  /** Stop timing before effect verification. Any wrong status or failed verification stops the run, without retry. */
  async operation<T extends { status: string }>(operation: string, phase: ProfileSample["phase"], work: () => Promise<T>,
    expected: string, verify: (result: T) => Promise<void> = async () => {}): Promise<T> {
    if (this.active) throw new Error("Concurrent root profiling is unsupported.");
    const start = this.now();
    const sample: ProfileSample = { operation, phase, duration_ms: 0, child_ms: 0, remaining_ms: 0,
      status: "threw", verified: false, success: false, children: [] };
    this.samples.push(sample); this.active = { start, sample };
    let result: T | undefined;
    try {
      result = await work();
      sample.status = ["observed", "acted", "listed", "closed", "refused", "unknown"].includes(result.status) ? result.status : "invalid_status";
    } catch { /* Do not copy native messages or arguments into a timing report. */ }
    finally {
      sample.duration_ms = this.now() - start; this.active = undefined;
      const ranges = sample.children.map(c => [c.start_ms, c.start_ms + c.duration_ms]).sort((a, b) => a[0] - b[0]);
      let end = 0;
      for (const [from, to] of ranges) { sample.child_ms += Math.max(0, to - Math.max(end, from)); end = Math.max(end, to); }
      sample.remaining_ms = Math.max(0, sample.duration_ms - sample.child_ms);
    }
    if (result && sample.status === expected && ["observed", "acted", "listed", "closed"].includes(sample.status)) {
      try { await verify(result); sample.verified = true; sample.success = true; }
      catch { sample.status = "verification_failed"; }
    }
    if (!sample.success) throw new Error("Profile operation failed; inspect the redacted sample. Do not replay input.");
    return result!;
  }

  /** Successful adapter times only. Failed samples remain in the raw report, never in these distributions. */
  summary() {
    const groups = new Map<string, ProfileSample[]>();
    for (const sample of this.samples.filter(s => s.success)) {
      const key = `${sample.phase}:${sample.operation}`;
      groups.set(key, [...groups.get(key) ?? [], sample]);
    }
    return [...groups.values()].map(samples => {
      const times = samples.map(s => s.duration_ms).sort((a, b) => a - b);
      const percentile = (p: number) => times[Math.max(0, Math.ceil(times.length * p) - 1)];
      return { operation: samples[0].operation, phase: samples[0].phase, count: times.length,
        min_ms: times[0], p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: times.at(-1)! };
    });
  }
}

/** Attempt every task-owned cleanup even after a partial failure. Never erase the original failure. */
export async function finishProfile(success: boolean, resources: Record<string, () => Promise<void>>) {
  const cleanup: Record<string, boolean> = {};
  for (const [name, close] of Object.entries(resources)) {
    try { await close(); cleanup[name] = true; }
    catch { cleanup[name] = false; }
  }
  return { success: success && Object.values(cleanup).every(Boolean), cleanup };
}
