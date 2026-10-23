# Temporal capture

> **History:** This page was written for the earlier `computer_observe`/`computer_act` tool set, which has been removed. Its behavior and limits still apply. Use the matching `computer:` addresses, Read views and Insert commands from [the resource guide](computer-resources.md) instead of the tool calls shown here.

`computer_sequence` captures one authorized Windows window or the primary display. Browser windows use the same native path. It does not encode video, raise a window, walk its accessibility tree or grant input authority.

## Capture and select in Codemode

```js
const captured = await tools.computer_sequence({
  window_ref: load("task_window"),
  capture: { duration_ms: 3000, fps: 4, scale: 0.5 }
});
text(captured.sequence); // Metadata only. Capture sends no image.
if (captured.status !== "observed") throw Error(captured.text);
store("task_sequence", captured.sequence.sequence_id);
store("task_observation", null); store("task_image", null);
```

Capture and selection are separate decisions. Read the timestamps, count and stop reason before choosing frames.

```js
const selected = await tools.computer_sequence({
  sequence_id: load("task_sequence"), selection: "endpoints"
});
if (selected.status !== "observed") throw Error(selected.text);
for (const frame of selected.frames) {
  text({ index: frame.index, time_ms: frame.timestamp_ms, source: frame.source });
  image(frame.image);
}
```

Use `display:"primary"` instead of `window_ref` for a read-only display sequence in YOLO. Safe denies display and unowned window captures. Stored frame selection checks current access and the window's lifetime again. Revocation withholds metadata and pixels. A closed or recreated window cannot return its retained frames.

## Bounds and settings

| Field in `capture` | Bounds / default |
| --- | --- |
| `duration_ms` | Required, 1..10000 |
| `fps` | 1..10, default 4; a goal, not guaranteed throughput |
| `max_frames` | 1..40, default 40 |
| `timeout_ms` | At least duration, at most 30000; default 15000 |
| `maxLongEdge` | 64..4096; defaults to current native image setting |
| `scale` | 0.05..1; defaults to current native image setting |
| `region` | Optional integer `{x,y,width,height}` in the first uncropped returned-image pixels |

Image settings are frozen before sampling. CUA owns native resizing. Crop extracts only the current CUA frame with the existing Sharp dependency. The initial region must fit; a smaller later raster clips it, and growth does not expand it. Each cropped frame reports requested/applied bounds and native origin when known. No prior overview or detail image is used as a hidden fallback.

The store holds the newest three sequences within 48 MiB of decoded image bytes. One frame is limited to 12 MiB. Count, byte or time limits are explicit. Close/reload drops resources. Base64 and metadata add memory beyond the decoded-byte limit.

## Timing and stop reasons

Frames are ordered and indexed from zero. `slot` is the scheduled sampling slot; `timestamp_ms` is the measured native-call completion relative to the start. It is not a compositor or paint timestamp. `capture_latency_ms` measures the native call; `sample_latency_ms` also includes access/identity checks and crop processing.

`actual_fps` is `(frame count - 1) / sample_span_ms`, in seconds. A single frame has no measured FPS. `interval_ms` reports min/max/mean intervals, making jitter visible. `elapsed_ms` is the whole capture call, not a fabricated requested duration. The last admitted read may finish after the requested duration; timeout/cancellation bounds further work.

Slow captures and delayed wakes skip expired slots instead of catching up with bursts. `skipped_slots` lists missed scheduled slots. `pending_slots` counts unsampled slots left by an early stop. No backend dropped-frame count is invented: CUA provides snapshots, not a continuous stream.

- `completed`: the scheduled duration was sampled, including any missed slots.
- `frame_limit`: the requested frame cap was reached. The resource is available, but the remaining slots were not sampled.
- `byte_limit`, `cancelled`, `timeout`, `target_lost`, `access_revoked`, `capture_failed`: partial or failed capture, never full success.

An interrupted resource may contain a known completed prefix. Cancellation withholds the current unfinished frame, stops the sampling loop and never retries a native call. The selected MCP driver owns in-flight cancellation and its 15-second per-call timeout. No detached capture loop is created.

Every frame reports source geometry and whether it changed from the previous frame. Movement/resize do not change the window lifetime; closed/reused handles stop capture. Native geometry and paint freshness can remain unknown. Capture retires that source's previous overview authority. **Observe again before input or detail**, even after selecting the last frame.

## Selection and further processing

Choose `all`, `first`, `last`, `endpoints`, `changed`, `{indexes:[0,2]}` or inclusive `{from:1,to:3}`. Indexes refer to captured frames, not sampling slots. Selection keeps temporal order. `changed` compares exact image bytes and geometry; it does not claim semantic relevance. Codemode receives an array of frame metadata and image blocks, suitable for explicit forwarding or further processing. Do not store whole image arrays in Codemode storage.

The existing debug viewer keeps its three ordinary boundary cards. A temporal dropdown also lists up to 40 sequence image blocks in the latest application-boundary request and lets the human inspect their exact bytes. Selection alone is not forwarding. Byte matching can be ambiguous when screenshots are identical; the viewer lists every retained possible source instead of inventing a timestamp. Asset eviction is visible. Final wire delivery remains unconfirmed.

