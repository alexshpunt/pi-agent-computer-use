# Temporal capture

See [the resource guide](computer-resources.md) for the current addresses, views and commands.

A `sequence` Read captures one authorized Windows window, or a machine's primary or listed display, on the machine that issued its address. Browser windows use the same native path. It does not encode video, raise a window, walk its accessibility tree or grant input authority.

## Capture, then select

Capture returns metadata only and sends no image. Capture and selection are separate decisions: read the timestamps, count and stop reason before choosing frames from the returned sequence.

Capture a display (`computer:machine/<name>/display/primary` or one listed by its `displays`) instead of a window for a read-only display sequence in YOLO. Frames are selected through the returned `computer:sequence/...` address, which runs on the machine that captured them. Safe denies display and unowned window captures. Stored frame selection checks current access and the window's lifetime again. Revocation withholds metadata and pixels. A closed or recreated window cannot return its retained frames.

## Bounds and settings

| Field | Bounds / default |
| --- | --- |
| `duration_ms` | Required, 1..60000 |
| `fps` | 1..30, default 4; a goal, not guaranteed throughput |
| `max_frames` | 1..300, default 40; one selection returns at most 40 |
| `timeout_ms` | At least duration, at most 90000; default 15000 |
| `maxLongEdge` | 64..4096; defaults to current native image setting |
| `scale` | 0.05..1; defaults to current native image setting |
| `region` | Optional integer `{x,y,width,height}` in the first uncropped returned-image pixels |

Image settings are frozen before sampling. CUA owns native resizing. Crop extracts only the current CUA frame with the existing Sharp dependency. The initial region must fit; a smaller later raster clips it, and growth does not expand it. Each cropped frame reports requested/applied bounds and native origin when known. No prior overview or detail image is used as a hidden fallback.

The store holds the newest three sequences within 48 MiB of decoded image bytes. One frame is limited to 12 MiB. Count, byte or time limits are explicit. Close/reload drops resources. Base64 and metadata add memory beyond the decoded-byte limit.

## Timing and stop reasons

Frames are ordered and indexed from zero. `slot` is the scheduled sampling slot; `timestamp_ms` is the measured native-call completion relative to the start. It is not a compositor or paint timestamp. `capture_latency_ms` measures the native call; `sample_latency_ms` also includes access/identity checks and crop processing.

`actual_fps` is `(frame count - 1) / sample_span_ms`, in seconds. A single frame has no measured FPS. `interval_ms` reports min/max/mean intervals, making jitter visible. `elapsed_ms` is the whole capture call, not a fabricated requested duration. The last admitted read may finish after the requested duration; timeout/cancellation bounds further work.

Slow captures and delayed wakes skip expired slots instead of catching up with bursts. `skipped_slots` lists missed scheduled slots. `pending_slots` counts unsampled slots left by an early stop; a watch stopped with `watch_stop` has none, because its duration is only a safety limit. No backend dropped-frame count is invented: CUA provides snapshots, not a continuous stream.

- `completed`: the scheduled duration was sampled, including any missed slots.
- `frame_limit`: the requested frame cap was reached. The resource is available, but the remaining slots were not sampled.
- `byte_limit`, `cancelled`, `timeout`, `target_lost`, `access_revoked`, `capture_failed`: partial or failed capture, never full success.

An interrupted resource may contain a known completed prefix. Cancellation withholds the current unfinished frame, stops the sampling loop and never retries a native call. The selected MCP driver owns in-flight cancellation and its 15-second per-call timeout. A sequence creates no detached capture loop; a [watch](#watch-while-acting) is the one capture that runs in the background.

Every frame reports source geometry and whether it changed from the previous frame. Movement/resize do not change the window lifetime; closed/reused handles stop capture. Native geometry and paint freshness can remain unknown. Capture retires that source's previous overview authority. **Observe again before input or detail**, even after selecting the last frame.

## Selection and further processing

Choose `all`, `first`, `last`, `endpoints`, `changed`, `{indexes:[0,2]}` or inclusive `{from:1,to:3}`. Indexes refer to captured frames, not sampling slots. Selection keeps temporal order. `changed` compares exact image bytes and geometry; it does not claim semantic relevance. Codemode receives an array of frame metadata and image blocks, suitable for explicit forwarding or further processing. Do not store whole image arrays in Codemode storage.

## One image of many frames

Add `as` to a JSON selection to get one image instead of one per frame:

| View | Returns |
| --- | --- |
| `frames:{"as":"sheet"}` | A contact sheet of all frames (at most 40): tiles in time order, left to right, each under a `#index · time` label. The text lists each tile's row, column, frame and time. |
| `frames:{"select":"changed","as":"sheet","columns":4}` | The same for another selection (`select`, `indexes` or `from`/`to`) with a fixed column count (1..10). |
| `frames:{"as":"max"}` or `"min"` | The per-pixel maximum or minimum of the selected frames: bright (or dark) detail from any frame appears at once, for example text revealed by a moving light. Frames must have one size. |

`region:{x,y,width,height}` crops every frame first, in the sequence's frame pixels (the overview size it was captured at); it is clipped to the frames and refused when it misses them. A sheet's long edge is 1600 px by default; tiles shrink together to fit, keeping their aspect ratio. `maxLongEdge` (64..4096) changes that limit, for example 16 tiles of a 640 px region in 4 columns at full size need 2560. A composite keeps the frames' size up to `maxLongEdge`. The image is read-only and grants no input.

## Watch while acting

`computer_record` `watch` starts capturing a window, or a viewport of it, and returns a sequence address once the first frame is in. Its sequence metadata says `running: true` with the frames so far, the elapsed time and the rate reached; a stop reason and slot counts come with `watch_stop`. Capture runs outside the session's queue through a second driver process on the same machine: a driver answers one call at a time, so a capture sent during a 2 s drag would otherwise wait for the drag to end. Starting that process takes a few seconds on the first watch; it stays until the session closes. A sandbox or isolated session has one driver connection, so its watch captures between the session's calls only.

| Field | Bounds / default |
| --- | --- |
| `fps` | 1..30, default 10; a goal, not guaranteed throughput |
| `timeout_ms` | 1..300000, default 60000; the watch stops by itself then |
| `maxLongEdge` | 64..4096, default 800; a viewport is captured so its own rectangle gets at most this many pixels on its long edge, never more than its full resolution |

A watch only looks: it does not take the window's observation, so refs and points of the latest Read stay valid for input. A frame with the same bytes as the one before shares its image and costs no memory; 3000 frames or 48 MiB of distinct frames stop the watch by itself. It checks process and window id on every frame, and stops when the window closes or access ends.

Each input or window action on the watched window notes its span, from the call to its result, in every running watch of that window; the receipt lists it with the frames captured during it. Read the sequence address with a `frames:` view while the watch runs, for example `frames:last`.

`watch_stop` ends the watch and returns:

- a contact sheet of the frames that differ from the one before and the last frame; above 40, the first, the last and those around each action stay and the rest are spread evenly. A frame captured during an action has its action's name on an orange label;
- the actions with their spans and frames, and the frames that changed most against the frame before, as a share of pixels and a box in frame pixels;
- the files: one PNG per frame that differs from the one before, and `watch.json` with every frame's time, file (a repeat names the file of the frame it repeats), size, change and actions. They go to `to` in the workspace, or to a temporary folder removed when the session closes. `video: true` adds `watch.webp`, an animated WebP of up to 200 distinct frames at 640 px, each shown until the next one.

The sequence keeps its frames for `frames:` Reads after the stop, like any sequence.

The existing debug viewer keeps its three ordinary boundary cards. A temporal dropdown also lists up to 40 sequence image blocks in the latest application-boundary request and lets the human inspect their exact bytes. Selection alone is not forwarding. Byte matching can be ambiguous when screenshots are identical; the viewer lists every retained possible source instead of inventing a timestamp. Asset eviction is visible. Final wire delivery remains unconfirmed.

