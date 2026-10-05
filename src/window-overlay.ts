import type { WindowTarget } from "./session.ts";

/** A successfully authorized whole-window observation, in native physical pixels. Never a crop or display. */
export interface WindowFrame {
  target: WindowTarget;
  identity: string;
  bounds: { x: number; y: number; width: number; height: number };
}
/** Private helper messages. The lifetime marker must never become a model-supplied targeting API. */
export type OverlayCommand = { kind: "flash"; generation: number; duration_ms: 2000 } & WindowFrame
  | { kind: "hide"; generation: number };
/** A helper acknowledgement is not proof of click-through or capture exclusion; those need native checks. */
export interface OverlayReply { status: string; generation: number }
/** A single owned rendering peer, with no capture or input operations. */
export interface OverlayPeer { send(command: OverlayCommand): Promise<OverlayReply>; close(): Promise<void> }
/** Public observation metadata. A failed visual aid must not change or replay the underlying operation. */
export interface HighlightResult { status: "shown" | "skipped" | "unavailable"; duration_ms?: number }
export type WindowObserver = (frame: WindowFrame, signal?: AbortSignal) => Promise<HighlightResult>;

/** Notify a rendering observer without changing capture success or sharing the private lifetime marker in results. */
export async function notifyWindowObserver(observer: WindowObserver | undefined, target: WindowTarget | undefined,
  identity: string | undefined, bounds: unknown, signal?: AbortSignal): Promise<HighlightResult | undefined> {
  if (!observer) return undefined;
  if (signal?.aborted) return { status: "skipped" };
  const value = bounds as WindowFrame["bounds"] | undefined;
  if (!target || !identity || !value || ![value.x, value.y, value.width, value.height].every(Number.isSafeInteger)
    || value.width <= 0 || value.height <= 0) return { status: "unavailable" };
  try { return await observer({ target: { ...target }, identity, bounds: { x: value.x, y: value.y, width: value.width, height: value.height } }, signal); }
  catch { return { status: "unavailable" }; }
}
function valid(frame: WindowFrame): boolean {
  const { target, bounds } = frame;
  const identity = /^PiComputerUse\.[a-f0-9]{32}:(\d+):([1-9]\d*)$/i.exec(frame.identity);
  return !!identity && Number(identity[1]) === target.pid && Number.isSafeInteger(Number(identity[2])) &&
    Number(identity[2]) > 0 &&
    [target.pid, target.window_id].every(value => Number.isSafeInteger(value) && value > 0) &&
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) &&
    Math.abs(bounds.x) <= 2_000_000 && Math.abs(bounds.y) <= 2_000_000 &&
    bounds.width > 0 && bounds.width <= 32768 && bounds.height > 0 && bounds.height <= 32768;
}

/** Lazily own one Qt frame process. Generations prevent late startup, cancellation or old reads repainting a newer frame. */
export class WindowOverlay {
  private starting?: Promise<OverlayPeer>;
  private generation = 0;
  private release?: () => void;
  private closed = false;

  constructor(private readonly createPeer: () => Promise<OverlayPeer>) {}

  /** Flash only a validated window lifetime. Native helper failure is fail-soft and never retried during this session. */
  async flash(frame: WindowFrame, signal?: AbortSignal): Promise<HighlightResult> {
    if (this.closed || signal?.aborted || !valid(frame)) return { status: "skipped" };
    const generation = ++this.generation;
    this.release?.(); this.release = undefined;
    this.starting ??= Promise.resolve().then(() => this.createPeer());
    try {
      const peer = await this.starting;
      if (generation !== this.generation || signal?.aborted || this.closed) return { status: "skipped" };
      const abort = () => { if (generation === this.generation) void this.clear(); };
      signal?.addEventListener("abort", abort, { once: true });
      const expiry = setTimeout(() => { if (generation === this.generation) { this.release?.(); this.release = undefined; } }, 2000);
      expiry.unref();
      this.release = () => { clearTimeout(expiry); signal?.removeEventListener("abort", abort); };
      const reply = await peer.send({ kind: "flash", generation, ...frame, duration_ms: 2000 });
      if (generation !== this.generation || signal?.aborted || this.closed) return { status: "skipped" };
      return reply.status === "shown" && reply.generation === generation ? { status: "shown", duration_ms: 2000 } : { status: "unavailable" };
    } catch { return { status: "unavailable" }; }
  }

  /** Invalidate pending flashes and hide a visible frame without starting an unused helper. */
  async clear(): Promise<void> {
    const generation = ++this.generation;
    this.release?.(); this.release = undefined;
    if (!this.starting) return;
    try {
      const peer = await this.starting;
      if (generation === this.generation) await peer.send({ kind: "hide", generation });
    } catch { /* A missing rendering aid must not block permission revocation. */ }
  }

  /** Stop this helper only. EOF owns native cleanup; never terminate source applications. */
  async close(): Promise<void> {
    this.closed = true; ++this.generation;
    this.release?.(); this.release = undefined;
    // Startup failure has no usable peer; uncertain shutdown of an existing peer must propagate.
    const peer = await this.starting?.catch(() => undefined);
    await peer?.close();
  }
}
