import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { marksAt, type FrameMark } from "./contact-sheet.ts";
import { decodeFrame, diffFrames, type PixelBox, type PixelFrame } from "./pixel-diff.ts";
import type { CaptureLimits, FrameSequence, SequenceFrame } from "./temporal-capture.ts";

/**
 * A watch captures a window or a viewport in the background while the agent acts, until it is stopped, its time
 * limit passes or the session closes. Frames that repeat the one before share its image, so a still window costs
 * little; the frame limit bounds a busy one.
 */
export const WATCH_LIMITS: CaptureLimits = { duration_ms: 300_000, fps: 30, max_frames: 3000, timeout_ms: 320_000 };
/** Defaults of a watch: 10 FPS for a minute, frames at most 800 px on their long edge. */
export const WATCH_DEFAULTS = { fps: 10, timeout_ms: 60_000, maxLongEdge: 800 } as const;
/** Frames on the contact sheet a stopped watch returns. */
export const WATCH_SHEET_FRAMES = 40;
/** Frames of the animation, and its long edge. */
export const ANIMATION_LIMITS = { frames: 200, longEdge: 640 } as const;

/** What a receipt says about one watch of the window an action ran on: the action's span in the watch's time and the frames captured in it. */
export interface WatchSpan { sequence_id: string; label: string; from_ms: number; to_ms: number; frames: { from: number; to: number } | null }

/** The first and last frame captured within a span of the watch's time; null when none was. */
export function framesBetween(frames: readonly Pick<SequenceFrame, "index" | "timestamp_ms">[], from: number, to: number): { from: number; to: number } | null {
  const inside = frames.filter(frame => frame.timestamp_ms >= from && frame.timestamp_ms <= to);
  return inside.length ? { from: inside[0].index, to: inside.at(-1)!.index } : null;
}

/** Whether a frame differs from the one before it: the first frame, other bytes or another size. */
export const differs = (frames: readonly SequenceFrame[], i: number) => i === 0 || frames[i].hash !== frames[i - 1].hash || frames[i].geometry_changed;

/**
 * The frames of a watch's contact sheet, in time order: every frame that differs from the one before, plus the last.
 * When there are more than `limit`, the first, the last and those around each action (the first changed frame at or
 * after it starts, the last during it and the first after it) stay, and the rest are spread evenly over the watch.
 */
export function sheetFrames(frames: readonly SequenceFrame[], marks: readonly FrameMark[], limit = WATCH_SHEET_FRAMES): SequenceFrame[] {
  if (!frames.length) return [];
  const changed = frames.filter((_, i) => differs(frames, i));
  if (changed.at(-1) !== frames.at(-1)) changed.push(frames.at(-1)!);
  if (changed.length <= limit) return changed;
  const keep = new Set<SequenceFrame>([changed[0], changed.at(-1)!]);
  for (const mark of marks) {
    const during = changed.filter(frame => frame.timestamp_ms >= mark.start_ms && frame.timestamp_ms <= mark.end_ms);
    const after = changed.find(frame => frame.timestamp_ms > mark.end_ms);
    for (const frame of [during[0], during.at(-1), after]) if (frame && keep.size < limit) keep.add(frame);
  }
  const rest = changed.filter(frame => !keep.has(frame));
  const room = limit - keep.size;
  for (let i = 0; i < room && rest.length; i++) keep.add(rest[Math.floor((i + 0.5) * rest.length / room)]);
  return changed.filter(frame => keep.has(frame));
}

/** How one frame differs from the one before it, in its own pixels: share of changed pixels and the box around them. */
export interface FrameChange { index: number; timestamp_ms: number; share: number; box?: PixelBox; size_changed?: true }

/** Change statistics of every frame against the one before it; repeated frames changed nothing. */
export async function frameChanges(frames: readonly SequenceFrame[]): Promise<FrameChange[]> {
  const changes: FrameChange[] = [];
  let previous: PixelFrame | undefined;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (i > 0 && !differs(frames, i)) { changes.push({ index: frame.index, timestamp_ms: frame.timestamp_ms, share: 0 }); continue; }
    const pixels = await decodeFrame(Buffer.from(frame.image.data, "base64"));
    if (!previous) changes.push({ index: frame.index, timestamp_ms: frame.timestamp_ms, share: 0 });
    else {
      const diff = diffFrames(previous, pixels);
      changes.push({ index: frame.index, timestamp_ms: frame.timestamp_ms, share: diff.size_changed ? 1 : diff.share,
        ...(diff.box ? { box: diff.box } : {}), ...(diff.size_changed ? { size_changed: true as const } : {}) });
    }
    previous = pixels;
  }
  return changes;
}

/** A short text of the frames that changed most, at most `limit` lines in time order. */
export function changeLines(changes: readonly FrameChange[], marks: readonly FrameMark[], limit = 20): string[] {
  const moving = changes.filter(change => change.share > 0);
  const shown = new Set([...moving].sort((a, b) => b.share - a.share).slice(0, limit));
  return moving.filter(change => shown.has(change)).map(change => {
    const actions = marksAt(marks, change.timestamp_ms);
    const box = change.box ? ` in ${change.box.x},${change.box.y} ${change.box.width}x${change.box.height}` : "";
    return `- #${change.index} at ${Math.round(change.timestamp_ms)} ms: ${change.size_changed ? "size changed" : `${(change.share * 100).toFixed(1)}%${box}`}${actions.length ? ` (during ${actions.join(", ")})` : ""}`;
  });
}

/** The files a stopped watch leaves: each frame that differs from the one before as a PNG, watch.json, and with `animation` watch.webp. */
export interface WatchFiles { dir: string; frames: number; json: string; animation?: string }

/**
 * Write a stopped watch's frames for further processing. watch.json lists every frame with its time, its file (shared
 * by the repeats after it), its change against the frame before and the actions it falls in, and every action.
 */
export async function writeWatchFiles(dir: string, sequence: FrameSequence, marks: readonly FrameMark[], changes: readonly FrameChange[],
  about: Record<string, unknown>, animation = false): Promise<WatchFiles> {
  await mkdir(dir, { recursive: true });
  const frames = sequence.frames;
  const files: string[] = [];
  let written = 0;
  for (let i = 0; i < frames.length; i++) {
    if (differs(frames, i)) {
      files.push(`frame-${String(frames[i].index).padStart(5, "0")}.png`);
      await writeFile(join(dir, files[i]), Buffer.from(frames[i].image.data, "base64"));
      written++;
    } else files.push(files[i - 1]);
  }
  const json = join(dir, "watch.json");
  await writeFile(json, JSON.stringify({ ...about, sequence_id: sequence.sequence_id, started_at: sequence.started_at, stop_reason: sequence.stop_reason,
    elapsed_ms: sequence.elapsed_ms, requested: sequence.requested, actual_fps: sequence.actual_fps, skipped_slots: sequence.skipped_slots.length, actions: marks,
    frames: frames.map((frame, i) => ({ index: frame.index, timestamp_ms: frame.timestamp_ms, file: files[i], width: frame.source.image.dimensions.width,
      height: frame.source.image.dimensions.height, changed_share: changes[i]?.share ?? null, changed_box: changes[i]?.box ?? null,
      actions: marksAt(marks, frame.timestamp_ms) })) }, null, 2));
  return { dir, frames: written, json, ...(animation && frames.length ? { animation: await writeAnimation(join(dir, "watch.webp"), frames) } : {}) };
}

/**
 * An animated WebP of the frames that differ from the one before, each shown until the next one, played once in real
 * time and then looped. More than ANIMATION_LIMITS.frames are spread evenly; all are fitted into one size.
 */
async function writeAnimation(path: string, frames: readonly SequenceFrame[]): Promise<string> {
  let picked = frames.filter((_, i) => differs(frames, i));
  if (picked.length > ANIMATION_LIMITS.frames)
    picked = Array.from({ length: ANIMATION_LIMITS.frames }, (_, i) => picked[Math.floor(i * picked.length / ANIMATION_LIMITS.frames)]);
  const first = picked[0].source.image.dimensions;
  const scale = Math.min(1, ANIMATION_LIMITS.longEdge / Math.max(first.width!, first.height!));
  const size = { width: Math.max(1, Math.round(first.width! * scale)), height: Math.max(1, Math.round(first.height! * scale)) };
  const images = await Promise.all(picked.map(frame => sharp(Buffer.from(frame.image.data, "base64")).removeAlpha()
    .resize(size.width, size.height, { fit: "contain", background: "#202020" }).png().toBuffer()));
  const delay = picked.map((frame, i) => Math.max(20, Math.round((picked[i + 1]?.timestamp_ms ?? frame.timestamp_ms + 1000) - frame.timestamp_ms)));
  await sharp(images, { join: { animated: true } }).webp({ delay, loop: 0, quality: 80 }).toFile(path);
  return path;
}
