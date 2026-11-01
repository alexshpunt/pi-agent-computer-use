import type { Content, WindowTarget } from "./session.ts";
import type { ScreenRect } from "./highlight-geometry.ts";

export interface VisualOptions {
  preset: "off" | "subtle" | "full";
  observations: boolean; previews: boolean; pointer: boolean; scroll_drag: boolean; keyboard: boolean;
  /** Show the text the agent types beside the action; the native renderer never stores it. */
  typed_text: boolean;
  opacity: number; quality: "performance" | "balanced" | "high"; reduced_motion: boolean;
}
const defaults = (): VisualOptions => ({ preset: "full", observations: true, previews: true, pointer: true,
  scroll_drag: true, keyboard: true, typed_text: true, opacity: 0.8, quality: "balanced", reduced_motion: false });
/** The settings the native renderer takes; whether typed text is sent at all is decided here. */
export function nativeVisualOptions(options: VisualOptions): Record<string, unknown> {
  const { typed_text: _typed, ...native } = options;
  return native;
}
/** Human-owned, session-local presentation preferences. No model tool can write them. */
export class VisualSettings {
  private value = defaults();
  private listeners = new Set<(value: VisualOptions) => void>();
  private revokers = new Set<() => void>();
  current(): VisualOptions { return { ...this.value }; }
  update(patch: Partial<VisualOptions>): VisualOptions { return this.apply(patch, this.value); }
  restore(patch: Partial<VisualOptions>): VisualOptions { return this.apply(patch, defaults()); }
  private apply(patch: Partial<VisualOptions>, base: VisualOptions): VisualOptions {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(k => !Object.hasOwn(base, k))) throw Error("Unknown visual setting.");
    const next = { ...base, ...patch };
    if (!["off", "subtle", "full"].includes(next.preset) || !["performance", "balanced", "high"].includes(next.quality) ||
      !Number.isFinite(next.opacity) || next.opacity < 0 || next.opacity > 1 ||
      [next.observations, next.previews, next.pointer, next.scroll_drag, next.keyboard, next.typed_text, next.reduced_motion].some(v => typeof v !== "boolean"))
      throw Error("Invalid visual settings.");
    if (patch.preset === "subtle" && patch.previews === undefined) next.previews = false;
    if (patch.preset === "full" && patch.previews === undefined) next.previews = true;
    this.value = next;
    for (const listener of this.listeners) listener(this.current());
    return this.current();
  }
  subscribe(listener: (value: VisualOptions) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  clear(): void { for (const revoke of this.revokers) revoke(); }
  onClear(revoke: () => void): () => void { this.revokers.add(revoke); return () => { this.revokers.delete(revoke); }; }
}

export interface HighlightMark { kind: "overview" | "detail" | "inspect" | "verify" | "action"; region?: ScreenRect; point?: { x: number; y: number } }
interface ActivityPayload {
  mark?: HighlightMark;
  image?: Extract<Content, { type: "image" }>;
  action?: string;
  outcome?: "delivered" | "refused" | "unknown" | "verified";
  /** Text the action types, already free of control characters and at most 200 characters. */
  typedText?: string;
}
export interface WindowFrame extends ActivityPayload { target: WindowTarget; identity: string; bounds: ScreenRect }
export interface DisplayFrame extends ActivityPayload { display: string; bounds: ScreenRect }
export type HighlightFrame = WindowFrame | DisplayFrame | { clear: true };
/** Queued is admission intent, never proof that pixels were shown or that input succeeded. */
export interface HighlightResult { status: "queued" | "shown" | "skipped" | "unavailable"; kind?: HighlightMark["kind"]; reason?: string; region?: ScreenRect; point?: { x: number; y: number } }
export type WindowObserver = (frame: HighlightFrame, signal?: AbortSignal) => Promise<HighlightResult>;
type Send = (name: "present_agent_activity" | "set_agent_visuals", args: Record<string, unknown>) => Promise<boolean | undefined>;

const rectangle = (r: ScreenRect) => r && [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
  Math.abs(r.x) <= 2_000_000 && Math.abs(r.y) <= 2_000_000 && r.width > 0 && r.width <= 32768 && r.height > 0 && r.height <= 32768;
function valid(frame: WindowFrame | DisplayFrame): boolean {
  const { bounds, mark } = frame;
  if (!rectangle(bounds)) return false;
  if ("display" in frame) { if (!frame.display || frame.display.length > 256 || "target" in frame) return false; }
  else {
    const identity = /^PiComputerUse\.[a-f0-9]{32}:(\d+):([1-9]\d*)$/i.exec(frame.identity);
    if (!identity || Number(identity[1]) !== frame.target.pid || !Number.isSafeInteger(Number(identity[2])) ||
      ![frame.target.pid, frame.target.window_id].every(v => Number.isSafeInteger(v) && v > 0)) return false;
  }
  if (!mark) return true;
  if (!["overview", "detail", "inspect", "verify", "action"].includes(mark.kind) || (mark.region && mark.point)) return false;
  const r = mark.region; const p = mark.point;
  if (r) return rectangle(r) && r.x >= bounds.x && r.y >= bounds.y && r.x + r.width <= bounds.x + bounds.width && r.y + r.height <= bounds.y + bounds.height;
  if (p) return [p.x, p.y].every(Number.isSafeInteger) && p.x >= bounds.x && p.y >= bounds.y && p.x < bounds.x + bounds.width && p.y < bounds.y + bounds.height;
  return mark.kind !== "detail" && (mark.kind !== "action" || !!frame.action || !!frame.outcome);
}
/** Validation and fail-soft notification never grant capture or input authority. */
export async function notifyHighlight(observer: WindowObserver | undefined, frame: WindowFrame | DisplayFrame | undefined, signal?: AbortSignal): Promise<HighlightResult | undefined> {
  if (!observer) return;
  if (signal?.aborted) return { status: "skipped" };
  if (!frame || !valid(frame)) {
    try { await observer({ clear: true }, signal); } catch { /* Presentation is optional. */ }
    return { status: "unavailable", reason: "native_geometry_unavailable" };
  }
  try { return { ...await observer(frame, signal), kind: frame.mark?.kind ?? "overview",
    ...(frame.mark?.region ? { region: { ...frame.mark.region } } : {}), ...(frame.mark?.point ? { point: { ...frame.mark.point } } : {}) }; }
  catch { return { status: "unavailable", reason: "renderer_unavailable" }; }
}
export function notifyWindowObserver(observer: WindowObserver | undefined, target: WindowTarget | undefined, identity: string | undefined,
  bounds: unknown, signal?: AbortSignal, mark?: HighlightMark, image?: Content, action?: string, outcome?: ActivityPayload["outcome"], typedText?: string): Promise<HighlightResult | undefined> {
  return notifyHighlight(observer, target && identity && bounds ? { target: { ...target }, identity, bounds: bounds as ScreenRect,
    ...(mark ? { mark } : {}), ...(image?.type === "image" ? { image } : {}), ...(action ? { action } : {}), ...(outcome ? { outcome } : {}),
    ...(typedText ? { typedText } : {}) } : undefined, signal);
}

/** What the card shows of a typed string: control characters become spaces and only the last 200 characters stay. */
export function shownTypedText(text: string | undefined): string | undefined {
  const shown = text?.replace(/\p{Cc}+/gu, " ").trim();
  return shown ? [...shown].slice(-200).join("") : undefined;
}

/** One native admission in flight and one replaceable pending image. Native owns animation timing. */
export class NativeVisuals {
  private generation = 0;
  private pending?: { name: "present_agent_activity" | "set_agent_visuals"; args: Record<string, unknown>; time: number };
  private config?: VisualOptions;
  private busy = false;
  private closed = false;
  private unavailable = false;
  private release?: () => void;
  private readonly unsubscribe: () => void;
  constructor(private readonly send: Send, private readonly settings = new VisualSettings()) {
    const preferences = settings.subscribe(value => {
      ++this.generation; this.release?.(); this.release = undefined; this.pending = undefined;
      this.config = value; this.drain();
    });
    const revocation = settings.onClear(() => this.clear());
    this.unsubscribe = () => { preferences(); revocation(); };
  }
  readonly flash: WindowObserver = async (frame, signal) => {
    if ("clear" in frame) { this.clear(); return { status: "skipped" }; }
    if (this.closed || signal?.aborted || this.settings.current().preset === "off") return { status: "skipped" };
    if (this.unavailable) return { status: "unavailable", reason: "native_visuals_unavailable" };
    if (!valid(frame)) { this.clear(); return { status: "unavailable", reason: "native_geometry_unavailable" }; }
    const generation = ++this.generation;
    this.release?.(); this.release = undefined;
    const { mark, image } = frame;
    const source = structuredClone("display" in frame ? { display: frame.display, bounds: frame.bounds } : { ...frame.target, identity: frame.identity, bounds: frame.bounds });
    const options = this.settings.current();
    if (mark?.kind !== "action" && !options.observations) return { status: "skipped" };
    const args: Record<string, unknown> = { generation, kind: mark?.kind ?? "overview", source,
      ...(mark?.region ? { region: { ...mark.region } } : {}), ...(mark?.point ? { point: { ...mark.point } } : {}),
      ...(frame.action ? { action: frame.action } : {}), ...(frame.outcome ? { outcome: frame.outcome } : {}),
      ...(mark?.kind === "action" && frame.typedText && (["scroll", "scroll_at", "drag"].includes(frame.action ?? "") ? options.scroll_drag : ["click", "right_click", "double_click"].includes(frame.action ?? "") ? options.pointer : options.keyboard && options.typed_text) ? { typed_text: frame.typedText } : {}) };
    // Bound transient transport memory. Oversized images still get a source frame, without a preview.
    if (options.previews && image && ["image/png", "image/jpeg"].includes(image.mimeType) && image.data.length <= 4 * 1024 * 1024)
      args.image = { data: image.data, mime_type: image.mimeType };
    this.pending = { name: "present_agent_activity", args, time: performance.now() };
    const abort = () => { if (generation === this.generation) this.clear(); };
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      const expiry = setTimeout(() => { if (generation === this.generation) { this.release?.(); this.release = undefined; } }, 1500);
      expiry.unref();
      this.release = () => { clearTimeout(expiry); signal.removeEventListener("abort", abort); };
    }
    this.drain();
    return { status: "queued" };
  };
  clear(): void {
    ++this.generation; this.release?.(); this.release = undefined;
    if (this.closed || this.unavailable) { this.pending = undefined; return; }
    this.pending = { name: "present_agent_activity", args: { kind: "clear", generation: this.generation }, time: performance.now() };
    this.drain();
  }
  private drain(): void {
    if (this.busy || this.closed || this.unavailable) return;
    const next = this.config ? { name: "set_agent_visuals" as const, args: nativeVisualOptions(this.config), time: performance.now() } : this.pending;
    if (!next) return;
    if (this.config) this.config = undefined; else this.pending = undefined;
    if (next.name === "present_agent_activity" && next.args.kind !== "clear" && performance.now() - next.time > 250) { this.drain(); return; }
    this.busy = true;
    void Promise.resolve().then(() => this.send(next.name, next.args)).then(ok => {
      if (ok === false) { this.unavailable = true; this.pending = undefined; this.config = undefined; }
    }).catch(() => { this.unavailable = true; this.pending = undefined; this.config = undefined; }).finally(() => { this.busy = false; this.drain(); });
  }
  close(): void { this.closed = true; ++this.generation; this.release?.(); this.pending = undefined; this.config = undefined; this.unsubscribe(); }
}
