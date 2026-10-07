# Observation granularity results

LPT-646 added image-only, UI-only and full fresh window observations. Full remains the default. See [usage](observation-granularity.md) and [redacted evidence](evidence/observation-granularity/run.json).

## Production proof

After reloading this extension, the real Codemode declaration exposed all three capture modes. One new owned browser fixture was used; the game, Paint and personal browser windows received no input.

- Full returned current UI and a 466×500 window PNG.
- Image-only returned pixels with no UI resource or retained native tokens. One pixel click hit the first Save button. Old hint/token input and a consumed observation were refused.
- UI-only returned current UI and hints with no image, pixel bounds or old detail authority. Pixel input, old zoom and image highlight were refused. One current hinted click hit the second Save button.
- The fixture's read-only event witness reported exactly two click events and two matching pointer events, and the current UI reported `Clicks: 2`. These were application effects, not merely delivery receipts.

The installed windows-shell-desktops runtime and its bytes were unchanged. The owned fixture exited successfully; source and private profile were removed. `computer_close` released the owned runtime without closing user windows.

## Warm latency sample

Six alternating full/image pairs used the same 500px cap, scale1, hints off and guides off. These are complete production-tool wall times, not native-only or compositor timestamps.

| Mode | Median | Range |
| --- | --- | --- |
| Full | 281ms | 259–316ms |
| Image | 211ms | 190–241ms |

Image-only saved 70ms (about25%) in this small fixture sample. Identity checks, native capture, transport and adapter work still remain; no instant-reaction or game-level claim follows from this result.

## Contracts and visible output

The initial regression failed the three new mode contracts before implementation. Focused behavioral tests and real Pi Codemode then passed. The deterministic native peer deliberately retains omitted native UI/pixel context; the adapter strips it instead of silently inheriting its authority. Tests also cover incompatible options, Safe access, foreign/retired/consumed IDs, window retirement and cancellation. No tests assert skill wording.

The actual Herdr viewport was inspected: pane w3ME:p2, revision1274, 304×108 cells, live bottom. Mode/guard/click/timing summaries were readable. Loop frames and base64 were not emitted. Unrelated boundary-extension errors were also present in the viewport; this task did not change that extension. The capture does not claim that collapsed images were rendered inline.

Final selected-tree qualification and delivery are recorded in the linked Linear Task. Private URLs, identifiers, pixels and raw event payloads remain outside tracked evidence.
