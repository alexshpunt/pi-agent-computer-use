import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Driver, DriverResult, WindowTarget } from "./session.ts";

/** Trusted local cursor-animation timing. Native mouse-event delays are not configurable here. */
export interface ReactiveAnimationConfig { glide_duration_ms: number }

/** Zero means automatic timing in CUA, so the minimal configured glide is a positive millisecond. */
export async function loadReactiveAnimationConfig(cwd: string): Promise<ReactiveAnimationConfig> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path.join(cwd, ".pi/reactive-animation.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { glide_duration_ms: 1 };
    throw Error("Invalid .pi/reactive-animation.json; use one integer glide_duration_ms in 1..5000.");
  }
  const config = value as Partial<ReactiveAnimationConfig>;
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== 1 ||
    !Number.isSafeInteger(config.glide_duration_ms) || config.glide_duration_ms! < 1 || config.glide_duration_ms! > 5000)
    throw Error("Reactive animation config accepts only integer glide_duration_ms in 1..5000.");
  return { glide_duration_ms: config.glide_duration_ms! };
}

/** Scope existing CUA animation controls to one explicit action, without changing native input delays. */
export class ReactiveAnimationDriver implements Driver {
  readonly reactiveAnimation = true;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private uncertain = false;
  private generation = 0;
  constructor(private readonly base: Driver, private readonly config: ReactiveAnimationConfig) {}
  get heldPaths() { return this.base.heldPaths; }
  get heldKeys() { return this.base.heldKeys; }
  get selectedDisplays() { return this.base.selectedDisplays; }
  get captureBoundDrag() { return this.base.captureBoundDrag; }

  /** Identity and permissions remain with the existing native peer. */
  identity(target: WindowTarget, create: boolean, signal?: AbortSignal) {
    return this.base.identity(target, create, signal);
  }

  /** Serialize profile scopes, so normal calls cannot inherit a concurrent reactive animation. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal,
    options?: { animation?: "reactive" }): Promise<DriverResult> {
    const generation = this.generation;
    const run = this.tail.catch(() => undefined).then(async () => {
      if (generation !== this.generation) throw Error("Animation request was closed before execution.");
      if (this.closed || this.uncertain) throw Error("Animation state is unavailable; close and rediscover before further input.");
      signal?.throwIfAborted();
      if (!options?.animation) return this.base.call(name, args, signal);
      const started = performance.now();
      const before = await this.motion(signal);
      let result: DriverResult, nativeMs = 0, restoreMs = 0, applyMs = 0;
      try {
        await this.set(this.config.glide_duration_ms, signal);
        applyMs = performance.now() - started;
        signal?.throwIfAborted();
        this.assertOpen();
        const nativeStart = performance.now();
        result = await this.base.call(name, args, signal);
        nativeMs = performance.now() - nativeStart;
      } finally {
        const restoreStart = performance.now();
        try {
          if (this.closed) throw Error("Animation runtime was closed during input.");
          // Cleanup must not inherit the already-cancelled action signal.
          await this.set(before);
          restoreMs = performance.now() - restoreStart;
        } catch {
          this.uncertain = true;
          throw Error("Cursor animation restoration is unconfirmed. Input may have happened; do not replay. Close and rediscover.");
        }
      }
      return { ...result, structuredContent: { ...result.structuredContent,
        animation: { profile: "reactive", glide_duration_ms: this.config.glide_duration_ms, previous_glide_duration_ms: before, restored: true,
          timing_ms: { apply: applyMs, native: nativeMs, restore: restoreMs } } } };
    });
    this.tail = run;
    return run;
  }

  private assertOpen(): void {
    if (this.closed) throw Error("Animation runtime was closed; no further native calls are allowed.");
  }

  private async motion(signal?: AbortSignal): Promise<number> {
    this.assertOpen();
    const result = await this.base.call("get_agent_cursor_state", {}, signal);
    const motion = result.structuredContent?.motion as { glide_duration_ms?: unknown } | undefined;
    const value = motion?.glide_duration_ms;
    if (result.isError || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5000)
      throw Error("Native cursor animation state is unavailable; no profile input was sent.");
    return value;
  }

  private async set(glide: number, signal?: AbortSignal): Promise<void> {
    this.assertOpen();
    const result = await this.base.call("set_agent_cursor_motion", { glide_duration_ms: glide }, signal);
    if (result.isError) throw Error("Native cursor animation update was refused.");
    // The native setter queues a render command; its receipt is not an applied-state guarantee.
    for (let i = 0; i < 6; i++) {
      if (await this.motion(signal) === glide) return;
      if (i < 5) await delay(5, undefined, { signal });
    }
    throw Error("Native cursor animation did not apply within six bounded state reads.");
  }

  /** Release the owned runtime only. A closed profile cannot reconnect while cleanup is running. */
  async close(): Promise<void> {
    this.closed = true; this.generation++;
    await this.base.close();
    await this.tail.catch(() => undefined);
    this.uncertain = false; this.closed = false;
  }
}
