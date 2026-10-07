# Observation sources

LPT-376 adds primary-display reading to the existing `computer_observe` tool. Native CUA remains the only capture backend. See [the verified results and limits](observation-sources-results.md).

```js
const view = await tools.computer_observe({ display: "primary" });
text(view.source);
image(view.image);
```

Choose exactly one `display` or `window_ref`. `query` is window-only. A display read is allowed in YOLO and refused in Safe before capture. If Safe is selected or the request is cancelled while native work is pending, its pixels are withheld. Only the user selects mode with `/computer-mode`; no observation argument promotes access.

A display image is read-only. It has no window reference or action observation ID, so it cannot ground `computer_act`. This task does not expose desktop-wide input. [Selected-display reads](selected-displays.md) require a separately qualified Windows runtime and a returned native display reference; they never fall back to primary. [Read-only window zoom and fresh display detail](native-detail.md) use a rectangle and image ID from the latest overview. Failed window capture never falls back to the desktop.

## Common metadata

Successful desktop-window, display and owned-browser images carry `source`:

- `kind`: `display`, `window` or `browser`.
- `domain`: `windows-host`. Native PIDs are Windows PIDs, not WSL PIDs.
- `identity`: session-local adapter identity and the applicable primary display, window reference, native PID/HWND or owned page target/tab. It does not grant future access.
- `captured_at` and `timestamp_boundary`: the adapter time after the native call completed, not a compositor freshness measurement.
- `image`: actual returned dimensions and coordinate scope; native-reported original dimensions and bounds when available. Overview origin is relative to its primary display or window. A native window zoom's origin is unreported here; CUA owns its mapping. Display detail reports its outward-rounded native origin and output dimensions separately.
- `semantic_scope`: no tree for display, native window UI for desktop windows, owned page semantics for the browser. Browser pixels include window chrome; page refs do not use those pixel coordinates.
- `scale`: native-reported scale factor and screenshot scale. DPI and browser devicePixelRatio remain `null`; do not infer them from resized images.
- `capabilities`: current read route, existing input boundary and supported detail route. Desktop windows expose native read-only window zoom; primary displays expose fresh adapter crop/resize. Browser zoom keeps its existing input contract.
- `visibility`: reported minimized state when available. Occlusion and paint freshness are not established by a successful capture.

The source envelope and exact returned bytes appear in existing Vision debug. The preview's application-boundary limitations remain unchanged: it does not prove final provider delivery or limit model context.

## Native settings and limits

Desktop windows and displays now use the same session-local settings as the owned browser: Lanczos3, default long-edge cap 500 and scale 1. Settings are frozen before each capture. Overview pixels stay native. Only fresh display detail uses adapter crop/resize; no originals are retained and CUA may round below the requested edge. A qualified 0.32.0 primary-display capture was 499×333 for a 500 cap, from a native 3840×2560 display with reported scale factor 1.5.

Window, display and owned-browser routes now share qualified CUA 0.33.2. Arbitrary window reads do not raise or focus that window. Only the separately approved owned-browser route raises its window before overview/zoom. Neither route guarantees fresh paint.

## Verification commands

```sh
npm test
npm run typecheck
npm run test:integration
# Only after explicit permission to read all visible primary-display contents:
node --experimental-transform-types scripts/verify-display-observation.mjs --allow-primary-display
```

The opt-in native probe uses trusted test mode changes, not interactive user input. It verifies Safe zero-dispatch, shared caps, unchanged native pixels and in-flight revocation. Private display PNGs stay in ignored `.tmp/display-observation/`; never upload them to Git or Linear. Durable evidence must exclude private window text and pixels.
