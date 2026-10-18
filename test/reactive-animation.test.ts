import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { ReactiveAnimationDriver, loadReactiveAnimationConfig } from "../src/reactive-animation.ts";
import type { Driver, DriverResult } from "../src/session.ts";

function fixture() {
  let glide = 240, applied = false;
  const calls: { name: string; args: Record<string, unknown>; signal?: AbortSignal; glide: number }[] = [];
  const control = { failRestore: false, refuse: false, abort: undefined as AbortController | undefined, stale: false };
  const base: Driver = {
    heldPaths: true, heldKeys: true, selectedDisplays: true, captureBoundDrag: true,
    identity: async () => "owned", close: async () => {},
    async call(name, args, signal): Promise<DriverResult> {
      calls.push({ name, args, signal, glide });
      if (name === "get_agent_cursor_state") return { content: [], structuredContent: { session: "owned", motion: { glide_duration_ms: glide } } };
      if (name === "set_agent_cursor_motion") {
        if (applied && args.glide_duration_ms === 240 && control.failRestore) throw Error("Restore failed");
        if (!control.stale) glide = Number(args.glide_duration_ms);
        applied = true;
        return { content: [], structuredContent: { motion: { glide_duration_ms: glide } } };
      }
      control.abort?.abort();
      if (signal?.aborted) throw Error("Native request aborted");
      return { content: [], structuredContent: { effect: control.refuse ? "refused" : "unverifiable" }, isError: control.refuse };
    },
  };
  return { driver: new ReactiveAnimationDriver(base, { glide_duration_ms: 1 }), calls, control, glide: () => glide };
}

test("ordinary calls do not change animation or add cursor requests", async () => {
  const f = fixture();
  await f.driver.call("click", { target: "fixture" });
  expect(f.calls.map(c => c.name)).toEqual(["click"]);
  expect(f.glide()).toBe(240);
  expect([f.driver.heldPaths, f.driver.heldKeys, f.driver.selectedDisplays, f.driver.captureBoundDrag]).toEqual([true, true, true, true]);
});

test("reactive calls use configured glide then restore the exact ordinary value", async () => {
  const f = fixture();
  const result = await f.driver.call("click", { target: "fixture" }, undefined, { animation: "reactive" });
  expect(f.calls.filter(c => c.name === "click")).toMatchObject([{ glide: 1, args: { target: "fixture" } }]);
  expect(f.calls.filter(c => c.name === "set_agent_cursor_motion").map(c => c.args)).toEqual([
    { glide_duration_ms: 1 }, { glide_duration_ms: 240 },
  ]);
  expect(f.glide()).toBe(240);
  expect(result.structuredContent).toMatchObject({ animation: { profile: "reactive", glide_duration_ms: 1, restored: true } });
  await f.driver.call("click", {});
  expect(f.calls.at(-1)?.glide).toBe(240);
});

test("native refusal and cancellation restore animation without replaying input", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(), controller = new AbortController();
    if (cancel) f.control.abort = controller; else f.control.refuse = true;
    const call = f.driver.call("click", {}, controller.signal, { animation: "reactive" });
    if (cancel) await expect(call).rejects.toThrow(/abort/i); else expect((await call).isError).toBe(true);
    expect(f.glide()).toBe(240);
    expect(f.calls.filter(c => c.name === "click")).toHaveLength(1);
    expect(f.calls.filter(c => c.name === "set_agent_cursor_motion").at(-1)?.signal).toBeUndefined();
  }
});

test("unapplied motion stops before input and failed restoration blocks later calls", async () => {
  const stale = fixture(); stale.control.stale = true;
  await expect(stale.driver.call("click", {}, undefined, { animation: "reactive" })).rejects.toThrow(/animation/i);
  expect(stale.calls.filter(c => c.name === "click")).toHaveLength(0);
  const failed = fixture(); failed.control.failRestore = true;
  await expect(failed.driver.call("click", {}, undefined, { animation: "reactive" })).rejects.toThrow(/restor/i);
  const before = failed.calls.length;
  await expect(failed.driver.call("click", {})).rejects.toThrow(/animation/i);
  expect(failed.calls).toHaveLength(before);
});

test("concurrent normal input cannot run inside another call's reactive profile", async () => {
  const f = fixture();
  await Promise.all([
    f.driver.call("click", { id: 1 }, undefined, { animation: "reactive" }),
    f.driver.call("click", { id: 2 }),
  ]);
  expect(f.calls.filter(c => c.name === "click").map(c => c.glide)).toEqual([1, 240]);
});

test("queued native motion is read back after a render turn before input and after restore", async () => {
  let glide = 240;
  const inputGlides: number[] = [];
  const base: Driver = {
    identity: async () => "owned", close: async () => {},
    async call(name, args) {
      if (name === "set_agent_cursor_motion") {
        setTimeout(() => { glide = Number(args.glide_duration_ms); }, 16);
        return { content: [], structuredContent: { motion: { glide_duration_ms: args.glide_duration_ms } } };
      }
      if (name === "get_agent_cursor_state") return { content: [], structuredContent: { motion: { glide_duration_ms: glide } } };
      inputGlides.push(glide); return { content: [], structuredContent: { effect: "unverifiable" } };
    },
  };
  const driver = new ReactiveAnimationDriver(base, { glide_duration_ms: 1 });
  try {
    await driver.call("click", {}, undefined, { animation: "reactive" });
    expect(inputGlides).toEqual([1]); expect(glide).toBe(240);
  } finally { await driver.close(); }
});

test("close during profile switching cannot reconnect native controls", async () => {
  let closed = false, notifyRead!: () => void;
  const firstMismatch = new Promise<void>(resolve => { notifyRead = resolve; });
  const afterClose: string[] = [];
  const base: Driver = {
    identity: async () => "owned", close: async () => { closed = true; },
    async call(name) {
      if (closed) afterClose.push(name);
      if (name === "get_agent_cursor_state") {
        notifyRead(); return { content: [], structuredContent: { motion: { glide_duration_ms: 240 } } };
      }
      return { content: [], structuredContent: {} };
    },
  };
  const driver = new ReactiveAnimationDriver(base, { glide_duration_ms: 1 });
  const outcome = Promise.allSettled([driver.call("click", {}, undefined, { animation: "reactive" })]);
  await firstMismatch; await driver.close();
  expect((await outcome)[0].status).toBe("rejected"); expect(afterClose).toEqual([]);
});

test("close rejects queued profile work but permits a later fresh runtime", async () => {
  const f = fixture();
  const queued = f.driver.call("click", {}, undefined, { animation: "reactive" });
  const outcome = Promise.allSettled([queued]);
  await f.driver.close();
  expect((await outcome)[0].status).toBe("rejected");
  expect(f.calls).toHaveLength(0);
  await f.driver.call("click", {});
  expect(f.calls.map(c => c.name)).toEqual(["click"]);
});

test("animation setup defaults to1ms and invalid settings fail instead of selecting automatic timing", async () => {
  await mkdir(".tmp/reactive-animation", { recursive: true });
  const dir = await mkdtemp(path.resolve(".tmp/reactive-animation/config-"));
  try {
    expect(await loadReactiveAnimationConfig(dir)).toEqual({ glide_duration_ms: 1 });
    await mkdir(path.join(dir, ".pi"));
    const file = path.join(dir, ".pi/reactive-animation.json");
    for (const value of [{ glide_duration_ms: 0 }, { glide_duration_ms: -1 }, { glide_duration_ms: .5 }, { glide_duration_ms: 5001 }, { glide_duration_ms: 1, click_delay_ms: 0 }]) {
      await writeFile(file, JSON.stringify(value));
      await expect(loadReactiveAnimationConfig(dir)).rejects.toThrow(/animation/i);
    }
    await writeFile(file, JSON.stringify({ glide_duration_ms: 2 }));
    expect(await loadReactiveAnimationConfig(dir)).toEqual({ glide_duration_ms: 2 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("readonly raster qualification follows the native driver through animation wrapping and revocation", () => {
  let policy: Driver["nativeDomRaster"] = {
    runtime: { source: "a".repeat(40), sha256: "b".repeat(64) },
    qualification: { runtime: { source: "a".repeat(40), sha256: "b".repeat(64) },
      browser: { product: "Chrome/tested", revision: "@tested" }, dpr: 1.5 },
  };
  const base: Driver = { get nativeDomRaster() { return policy; },
    identity: async () => "owned", close: async () => {}, call: async () => { throw Error("Metadata forwarding must not call native"); } };
  const wrapped: Driver = new ReactiveAnimationDriver(base, { glide_duration_ms: 1 });
  expect(wrapped.nativeDomRaster).toEqual(policy);
  policy = undefined;
  expect(wrapped.nativeDomRaster).toBeUndefined();
  expect(fixture().driver.nativeDomRaster).toBeUndefined();
});