import type { WindowTarget } from "./session.ts";
import type { ScreenRect } from "./highlight-geometry.ts";

/** An internal human-only primitive in physical screen coordinates. */
export interface HighlightMark { kind: "overview" | "detail" | "action"; region?: ScreenRect; point?: { x: number; y: number } }
/** A successfully authorized window lifetime, never a model-supplied drawing target. */
export interface WindowFrame {
  target: WindowTarget;
  identity: string;
  bounds: ScreenRect;
  mark?: HighlightMark;
}
/** Display marks require an authorized primary-display read; they grant no input. */
export interface DisplayFrame { display: "primary"; bounds: ScreenRect; mark?: HighlightMark }
export type HighlightFrame = WindowFrame | DisplayFrame | { clear: true };
/** Private helper messages. */
export type OverlayCommand = { kind: "flash"; generation: number; duration_ms: 2000 } & (WindowFrame | DisplayFrame)
  | { kind: "hide"; generation: number };
/** A reply is not proof of click-through or capture exclusion; those need native checks. */
export interface OverlayReply { status: string; generation: number; reason?: string }
/** A single owned rendering peer, with no capture or input operations. */
export interface OverlayPeer { send(command: OverlayCommand): Promise<OverlayReply>; close(): Promise<void> }
/** Drawing failure never changes or replays the underlying capture/input. */
export interface HighlightResult { status: "shown" | "skipped" | "unavailable"; duration_ms?: number; kind?: HighlightMark["kind"]; reason?: string; region?: ScreenRect; point?: { x: number; y: number } }
export type WindowObserver = (frame: HighlightFrame, signal?: AbortSignal) => Promise<HighlightResult>;

/** Fail-soft notification. An unavailable target clears the previous mark instead of inventing a frame. */
export async function notifyHighlight(observer: WindowObserver | undefined, frame: WindowFrame | DisplayFrame | undefined,
  signal?: AbortSignal): Promise<HighlightResult | undefined> {
  if (!observer) return undefined;
  if (signal?.aborted) return { status: "skipped" };
  if (!frame || !valid(frame)) {
    try { await observer({ clear: true }, signal); } catch { /* Optional visual aid. */ }
    return { status: "unavailable", reason: "native_geometry_unavailable" };
  }
  try {
    const result = await observer(frame, signal);
    const mark = frame.mark;
    return { ...result, kind: mark?.kind ?? "overview", ...(mark?.region ? { region: { ...mark.region } } : {}),
      ...(mark?.point ? { point: { ...mark.point } } : {}) };
  } catch { return { status: "unavailable", reason: "renderer_unavailable" }; }
}

/** Keep the retained browser research adapter's whole-window observer contract. */
export async function notifyWindowObserver(observer: WindowObserver | undefined, target: WindowTarget | undefined,
  identity: string | undefined, bounds: unknown, signal?: AbortSignal, mark?: HighlightMark): Promise<HighlightResult | undefined> {
  return notifyHighlight(observer, target && identity && bounds ? { target: { ...target }, identity, bounds: bounds as ScreenRect, ...(mark ? { mark } : {}) } : undefined, signal);
}
function valid(frame: WindowFrame | DisplayFrame): boolean {
  const { bounds, mark } = frame;
  const rectangle = (r: ScreenRect) => r && [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
    Math.abs(r.x) <= 2_000_000 && Math.abs(r.y) <= 2_000_000 && r.width > 0 && r.width <= 32768 && r.height > 0 && r.height <= 32768;
  if (!rectangle(bounds)) return false;
  if ("display" in frame) { if (frame.display !== "primary" || "target" in frame || bounds.x !== 0 || bounds.y !== 0) return false; }
  else {
    const identity = /^PiComputerUse\.[a-f0-9]{32}:(\d+):([1-9]\d*)$/i.exec(frame.identity);
    if (!identity || Number(identity[1]) !== frame.target.pid || !Number.isSafeInteger(Number(identity[2])) || Number(identity[2]) <= 0 ||
      ![frame.target.pid, frame.target.window_id].every(v => Number.isSafeInteger(v) && v > 0)) return false;
  }
  if (!mark) return true;
  if (!["overview", "detail", "action"].includes(mark.kind)) return false;
  if (mark.kind === "overview") return !mark.region && !mark.point;
  if (!!mark.region === !!mark.point || (mark.kind === "detail" && !mark.region)) return false;
  const r = mark.region; const p = mark.point;
  return r ? rectangle(r) && r.x >= bounds.x && r.y >= bounds.y &&
    r.x + r.width <= bounds.x + bounds.width && r.y + r.height <= bounds.y + bounds.height :
    !!p && [p.x, p.y].every(Number.isSafeInteger) && p.x >= bounds.x && p.y >= bounds.y &&
    p.x < bounds.x + bounds.width && p.y < bounds.y + bounds.height;
}

/** Lazily own one Qt frame process. Generations prevent late startup, cancellation or old reads repainting a newer frame. */
export class WindowOverlay {
  private starting?: Promise<OverlayPeer>;
  private generation = 0;
  private release?: () => void;
  private closed = false;

  constructor(private readonly createPeer: () => Promise<OverlayPeer>) {}

  /** Flash a validated source/primitive. Native failure is fail-soft and never retried during this session. */
  async flash(frame: HighlightFrame, signal?: AbortSignal): Promise<HighlightResult> {
    if ("clear" in frame) { await this.clear(); return { status: "skipped" }; }
    if (this.closed || signal?.aborted) return { status: "skipped" };
    if (!valid(frame)) { await this.clear(); return { status: "unavailable", reason: "native_geometry_unavailable" }; }
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
      return reply.status === "shown" && reply.generation === generation ? { status: "shown", duration_ms: 2000 } : { status: "unavailable", reason: reply.reason ?? "renderer_refused" };
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
