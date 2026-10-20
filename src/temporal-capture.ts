import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import type { Content } from "./session.ts";
import type { ObservationSource } from "./observation-source.ts";
import type { CuaVisionSettings } from "./cua-image-settings.ts";

/** Bounded native sampling. Region uses pixels in the first uncropped frame at the frozen image cap. */
export interface SequenceOptions {
  duration_ms: number; fps?: number; max_frames?: number; timeout_ms?: number;
  maxLongEdge?: number; scale?: number; region?: { x: number; y: number; width: number; height: number };
}
/** A stored frame is read-only. Native completion is the timestamp boundary, not compositor presentation. */
export interface SequenceFrame {
  index: number; slot: number; timestamp_ms: number; capture_started_ms: number; capture_latency_ms: number; sample_latency_ms: number;
  hash: string; bytes: number; source: ObservationSource; geometry_changed: boolean;
  image: Extract<Content, { type: "image" }>;
}
/** No images are included in the public capture metadata. Partial prefixes never mean full success. */
export interface FrameSequence {
  sequence_id: string; requested: { duration_ms: number; fps: number; max_frames: number; timeout_ms: number };
  started_at: string; elapsed_ms: number; sample_span_ms: number; actual_fps: number | null;
  /** How old the newest frame was when the sequence returned: time from its native completion to the result. */
  last_frame_age_ms: number | null;
  skipped_slots: number[]; pending_slots: number; payload_bytes: number;
  stop_reason: "completed" | "frame_limit" | "byte_limit" | "cancelled" | "timeout" | "target_lost" | "access_revoked" | "capture_failed";
  frames: SequenceFrame[];
  configuration?: CuaVisionSettings;
  interval_ms?: { min: number; max: number; mean: number };
}
/** Inclusive range and indexes refer to captured frame indexes, not scheduled sampling slots. */
export type FrameSelection = "all" | "first" | "last" | "endpoints" | "changed" | { indexes: number[] } | { from: number; to: number };
const byteBudget = 48 * 1024 * 1024;
/** A scoped capture can stop without exposing backend diagnostics or falling back to another target. */
export class SequenceStop extends Error {
  constructor(readonly reason: FrameSequence["stop_reason"]) { super(reason); }
}
/** Limits of one sequence: a minute of frames at up to 30 FPS; one Read still selects at most 40 of them. */
export const SEQUENCE_LIMITS = { duration_ms: 60_000, fps: 30, max_frames: 300, timeout_ms: 90_000, selected: 40 } as const;
/** Validate before native dispatch; requested FPS is a sampling goal, never a performance promise. */
export function validateSequence(options: SequenceOptions): FrameSequence["requested"] {
  const result = { duration_ms: options.duration_ms, fps: options.fps ?? 4, max_frames: options.max_frames ?? 40, timeout_ms: options.timeout_ms ?? 15000 };
  const L = SEQUENCE_LIMITS;
  if (!Number.isSafeInteger(result.duration_ms) || result.duration_ms < 1 || result.duration_ms > L.duration_ms ||
    !Number.isFinite(result.fps) || result.fps < 1 || result.fps > L.fps ||
    !Number.isSafeInteger(result.max_frames) || result.max_frames < 1 || result.max_frames > L.max_frames ||
    !Number.isSafeInteger(result.timeout_ms) || result.timeout_ms < result.duration_ms || result.timeout_ms > L.timeout_ms)
    throw Error(`Use duration_ms 1..${L.duration_ms}, fps 1..${L.fps}, max_frames 1..${L.max_frames} and timeout_ms duration..${L.timeout_ms}.`);
  const r = options.region;
  if (r && (![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) || r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1))
    throw Error("Region uses positive integer dimensions and non-negative local pixel coordinates.");
  return result;
}

/** Sequential sampling skips missed slots. The clock seam allows deterministic timing contract checks. */
export async function collectSequence(options: SequenceOptions,
  capture: (signal: AbortSignal) => Promise<{ image: SequenceFrame["image"]; source: ObservationSource; native_completed_at?: number; native_latency_ms?: number }>, signal?: AbortSignal,
  clock: { now(): number; wait(ms: number, active: AbortSignal): Promise<void> } = { now: () => performance.now(), wait: (ms, active) => delay(ms, undefined, { signal: active }) }): Promise<FrameSequence> {
  const requested = validateSequence(options); const started = clock.now();
  const timeout = AbortSignal.timeout(requested.timeout_ms);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const sequence: FrameSequence = { sequence_id: "seq-" + randomUUID(), requested, started_at: new Date().toISOString(),
    elapsed_ms: 0, sample_span_ms: 0, actual_fps: null, last_frame_age_ms: null, skipped_slots: [], pending_slots: 0, payload_bytes: 0, stop_reason: "completed", frames: [] };
  const interval = 1000 / requested.fps; const slots = Math.ceil(requested.duration_ms / interval);
  let slot = 0;
  try {
    while (slot < slots) {
      if (active.aborted) throw new SequenceStop(signal?.aborted ? "cancelled" : "timeout");
      if (sequence.frames.length >= requested.max_frames) { sequence.stop_reason = "frame_limit"; break; }
      const wait = started + slot * interval - clock.now();
      if (wait > 0) await clock.wait(wait, active);
      active.throwIfAborted();
      // A delayed wake can miss more than one scheduled slot. Never catch up with a burst.
      while (slot < slots && (slot + 1) * interval <= clock.now() - started) sequence.skipped_slots.push(slot++);
      if (slot > 0 && clock.now() - started >= requested.duration_ms) {
        while (slot < slots) sequence.skipped_slots.push(slot++);
      }
      if (slot >= slots) break;
      const before = clock.now(); const result = await capture(active); const after = clock.now();
      active.throwIfAborted();
      const bytes = Buffer.from(result.image.data, "base64");
      if (bytes.length > 12 * 1024 * 1024 || sequence.payload_bytes + bytes.length > byteBudget) { sequence.stop_reason = "byte_limit"; break; }
      const previous = sequence.frames.at(-1);
      const geometry = (source: ObservationSource) => JSON.stringify({ image: source.image, scale: source.scale });
      sequence.frames.push({ index: sequence.frames.length, slot, timestamp_ms: (result.native_completed_at ?? after) - started, capture_started_ms: before - started,
        capture_latency_ms: result.native_latency_ms ?? after - before, sample_latency_ms: after - before, hash: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
        source: result.source, geometry_changed: !!previous && geometry(previous.source) !== geometry(result.source), image: result.image });
      sequence.payload_bytes += bytes.length; slot++;
      while (slot < slots && slot * interval < clock.now() - started) sequence.skipped_slots.push(slot++);
    }
  } catch (error) {
    sequence.stop_reason = signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : error instanceof SequenceStop ? error.reason : "capture_failed";
  }
  sequence.elapsed_ms = clock.now() - started;
  sequence.last_frame_age_ms = sequence.frames.length ? sequence.elapsed_ms - sequence.frames.at(-1)!.timestamp_ms : null;
  sequence.pending_slots = slots - sequence.frames.length - sequence.skipped_slots.length;
  sequence.sample_span_ms = sequence.frames.length > 1 ? sequence.frames.at(-1)!.timestamp_ms - sequence.frames[0].timestamp_ms : 0;
  sequence.actual_fps = sequence.sample_span_ms > 0 ? (sequence.frames.length - 1) * 1000 / sequence.sample_span_ms : null;
  const intervals = sequence.frames.slice(1).map((frame, i) => frame.timestamp_ms - sequence.frames[i].timestamp_ms);
  if (intervals.length) sequence.interval_ms = { min: Math.min(...intervals), max: Math.max(...intervals), mean: sequence.sample_span_ms / intervals.length };
  return sequence;
}

/** Small valid-JSON text projection; full per-frame source geometry remains in structured results. */
export function frameSummary(frame: Omit<SequenceFrame, "image">) {
  return { index: frame.index, slot: frame.slot, timestamp_ms: frame.timestamp_ms, capture_latency_ms: frame.capture_latency_ms,
    sample_latency_ms: frame.sample_latency_ms, hash: frame.hash, bytes: frame.bytes, geometry_changed: frame.geometry_changed,
    dimensions: frame.source.image.dimensions, native_bounds: frame.source.image.native_bounds };
}
/** Remove pixel payloads for tool metadata, trace and context. */
export function sequenceMetadata(sequence: FrameSequence) {
  return { ...sequence, frames: sequence.frames.map(({ image: _image, ...frame }) => frame),
    timestamp_boundary: "native_call_completed", input: "none", retention: "session-local; newest 3 sequences within 48 MiB" };
}
/** Select an ordered subset; changed means exact byte changes, not a model judgement. */
export function selectFrames(sequence: FrameSequence, selection: FrameSelection): SequenceFrame[] {
  const frames = sequence.frames;
  if (selection === "all") {
    if (frames.length > SEQUENCE_LIMITS.selected) throw Error(`This sequence has ${frames.length} frames; select at most ${SEQUENCE_LIMITS.selected} with indexes, a range or changed.`);
    return frames;
  }
  if (selection === "first") return frames.slice(0, 1);
  if (selection === "last") return frames.slice(-1);
  if (selection === "endpoints") return frames.filter((_, i) => i === 0 || i === frames.length - 1);
  if (selection === "changed") return frames.filter((f, i) => i === 0 || f.hash !== frames[i - 1].hash || f.geometry_changed);
  if (!selection || typeof selection !== "object") throw Error("Choose all, first, last, endpoints, changed, indexes or an inclusive range.");
  const indexes = "indexes" in selection ? selection.indexes : Array.from({ length: selection.to - selection.from + 1 }, (_, i) => selection.from + i);
  if (!Array.isArray(indexes) || indexes.length < 1 || indexes.length > SEQUENCE_LIMITS.selected ||
    indexes.some(i => !Number.isSafeInteger(i) || i < 0 || i >= frames.length) || new Set(indexes).size !== indexes.length)
    throw Error("Selection needs unique valid captured-frame indexes or an inclusive from..to range.");
  return frames.filter(f => indexes.includes(f.index));
}
/** Crop fresh CUA frame pixels only; resize clips the fixed first-frame region instead of expanding it. */
export async function cropSequenceFrame(image: SequenceFrame["image"], source: ObservationSource, requested: NonNullable<SequenceOptions["region"]>, first: boolean) {
  const width = source.image.dimensions.width!; const height = source.image.dimensions.height!;
  if (first && (requested.x + requested.width > width || requested.y + requested.height > height))
    throw Error("Region must fit the first uncropped frame at the requested image size.");
  const applied = { ...requested, width: Math.min(requested.width, width - requested.x), height: Math.min(requested.height, height - requested.y) };
  if (applied.width <= 0 || applied.height <= 0) throw Error("Resized frame no longer contains the region.");
  const bytes = await sharp(Buffer.from(image.data, "base64"), { limitInputPixels: 32 * 1024 * 1024 })
    .extract({ left: applied.x, top: applied.y, width: applied.width, height: applied.height }).png().toBuffer();
  const native = source.image.original_dimensions;
  const origin = native ? { x: requested.x * native.width / width, y: requested.y * native.height / height,
    relative_to: source.kind === "display" ? "primary_display" as const : "window" as const } : null;
  return { image: { ...image, data: bytes.toString("base64") }, source: { ...source, image: { ...source.image,
    scope: source.kind === "display" ? "primary_display_region" as const : "native_window_zoom" as const,
    coordinate_space: "detail_image_pixels" as const, dimensions: { width: applied.width, height: applied.height }, origin,
    crop: { requested, applied, coordinate_space: "uncropped_image_pixels" as const } } } };
}
/** Private bounded frame resources. Reload/close drops pixels; readers must recheck source access. */
export class SequenceStore {
  private readonly sequences = new Map<string, FrameSequence>();
  put(sequence: FrameSequence): void {
    this.sequences.set(sequence.sequence_id, sequence);
    while (this.sequences.size > 3 || [...this.sequences.values()].reduce((sum, s) => sum + s.payload_bytes, 0) > byteBudget)
      this.sequences.delete(this.sequences.keys().next().value!);
  }
  get(id: string): FrameSequence | undefined { return this.sequences.get(id); }
  clear(): void { this.sequences.clear(); }
}
