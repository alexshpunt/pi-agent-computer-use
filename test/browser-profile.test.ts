import { expect, test, vi } from "vitest";
import { BrowserProfile, finishProfile } from "../src/browser-profile.ts";

test("account overlapping children once and exclude verification from adapter time", async () => {
  let clock = 0;
  const profile = new BrowserProfile(() => clock);
  await profile.operation("zoom", "warm", async () => {
    clock = 2;
    await profile.child("native.zoom", async () => {
      clock = 4;
      await profile.child("identity", async () => { clock = 8; });
      clock = 12;
    });
    clock = 15;
    return { status: "observed", secret: "private URL and pixels" };
  }, "observed", async () => { clock = 100; });
  expect(profile.samples[0]).toMatchObject({ duration_ms: 15, child_ms: 10, remaining_ms: 5, verified: true, success: true });
  expect(profile.samples[0].children.map(c => [c.name, c.start_ms, c.duration_ms])).toEqual([
    ["native.zoom", 2, 10], ["identity", 4, 4],
  ]);
  expect(JSON.stringify(profile.samples)).not.toContain("secret");
  expect(profile.summary()[0]).toMatchObject({ operation: "zoom", phase: "warm", count: 1, p50_ms: 15 });
});

test("unknown input and failed effect verification stay failed without retrying or leaking errors", async () => {
  const profile = new BrowserProfile();
  const input = vi.fn(async () => ({ status: "unknown", text: "private" }));
  await expect(profile.operation("click", "warm", input, "acted")).rejects.toThrow("Profile operation failed");
  expect(input).toHaveBeenCalledTimes(1);
  await expect(profile.operation("fill", "warm", async () => ({ status: "acted" }), "acted", async () => {
    throw new Error("http://private/?password=secret");
  })).rejects.toThrow("Profile operation failed");
  expect(profile.samples.map(s => s.success)).toEqual([false, false]);
  expect(profile.samples[1].status).toBe("verification_failed");
  expect(profile.summary()).toEqual([]);
  expect(JSON.stringify(profile.samples)).not.toMatch(/private|password|secret/);
});

test("even an expected refusal or unknown result cannot count as a successful timing sample", async () => {
  const profile = new BrowserProfile();
  for (const status of ["refused", "unknown"]) {
    await expect(profile.operation("click", "warm", async () => ({ status }), status)).rejects.toThrow("Profile operation failed");
  }
  expect(profile.summary()).toEqual([]);
});
test("partial-run cleanup attempts every owned resource and cannot turn a failed run into success", async () => {
  const browser = vi.fn(async () => { throw new Error("private native identity"); });
  const helper = vi.fn(async () => {});
  const fixture = vi.fn(async () => {});
  const result = await finishProfile(false, { browser, helper, fixture });
  expect(result).toEqual({ success: false, cleanup: { browser: false, helper: true, fixture: true } });
  expect([browser, helper, fixture].every(fn => fn.mock.calls.length === 1)).toBe(true);
  expect((await finishProfile(false, { helper })).success).toBe(false);
});
