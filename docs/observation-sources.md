# Observation sources

See [the resource guide](computer-resources.md) for the current addresses, views and commands.

Window and display Reads share one source contract. Native CUA remains the only capture backend.

Read exactly one source: a window or a display. A UI query is window-only. A display read is allowed in YOLO and refused in Safe before capture. If Safe is selected or the request is cancelled while native work is pending, its pixels are withheld. Only the user selects mode with `/computer-mode`; no observation argument promotes access.

A display image is read-only. It has no window reference or input observation, so it cannot ground input. This task does not expose desktop-wide input. [Selected-display reads](selected-displays.md) require a separately qualified Windows runtime and a returned native display reference; they never fall back to primary. [Read-only window zoom and fresh display detail](native-detail.md) use a rectangle and image ID from the latest overview. Failed window capture never falls back to the desktop.

## Common metadata

Successful desktop-window and display images carry `source`. Playwright page screenshots report their own `playwright_screenshot` route instead.

- `kind`: `display` or `window`.
- `domain`: `windows-host`. Native PIDs are Windows PIDs, not WSL PIDs.
- `identity`: session-local adapter identity and the applicable primary display, window reference or native PID/HWND. It does not grant future access.
- `captured_at` and `timestamp_boundary`: the adapter time after the native call completed, not a compositor freshness measurement.
- `image`: actual returned dimensions and coordinate scope; native-reported original dimensions and bounds when available. Overview origin is relative to its primary display or window. A native window zoom's origin is unreported here; CUA owns its mapping. Display detail reports its outward-rounded native origin and output dimensions separately.
- `semantic_scope`: no tree for display, native window UI for desktop windows.
- `scale`: native-reported scale factor and screenshot scale. DPI and devicePixelRatio remain `null`; do not infer them from resized images.
- `capabilities`: current read route, existing input boundary and supported detail route. Desktop windows expose native read-only window zoom; primary displays expose fresh adapter crop/resize.
- `visibility`: reported minimized state when available. Occlusion and paint freshness are not established by a successful capture.

The source envelope and exact returned bytes appear in existing Vision debug. The preview's application-boundary limitations remain unchanged: it does not prove final provider delivery or limit model context.

## Native settings and limits

Desktop windows and displays use session-local settings: Lanczos3, default long-edge cap 1280 and scale 1. Settings are frozen before each capture. Overview pixels stay native. Only fresh display detail uses adapter crop/resize; no originals are retained and CUA may round below the requested edge.

Window and display routes use the selected qualified CUA runtime. Arbitrary window reads do not raise or focus that window. Neither route guarantees fresh paint.

## Verification commands

```sh
npm test
npm run typecheck
npm run test:integration
```

