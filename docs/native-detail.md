# Window zoom and display detail

See [the resource guide](computer-resources.md) for the current addresses, views and commands.

CUA 0.33.2 is the qualified Windows runtime for window, display and browser tools. It remains unmodified. Native window zoom is reused directly; the driver still has no display-region capture, so our adapter crops a fresh full-resolution display PNG.

## Select from an overview

Read one source first: a window or a display. Then select a rectangle from that returned PNG, not from remembered pixels or CSS coordinates, and read it as detail from that overview's observation. Use the current image's actual bounds. Results report refusals through their status; check it before continuing.

A window detail uses that window's latest overview. Window zoom is CUA's fresh JPEG with native padding and a 500px width limit; height can exceed 500. There is no automatic foregrounding or display fallback. Browser zoom and its input contract are unchanged.

## Fresh pixels, not a saved crop

Window detail calls native `zoom` with the original overview rectangle. Moving, shrinking, growing or changing scale does not invalidate that request. CUA keeps the original screenshot-to-native scale, captures fresh window pixels, and clips its padded crop to the current raster. Growth does not stretch or expand the requested region. The human frame uses the current window origin and clips the original local region to current bounds. Window lifetime, permission and cancellation are separate checks. JPEG padding and mapping belong to CUA; its response does not expose the native crop origin, so that origin stays null.

Display detail maps the overview rectangle to native pixels once, rounding outwards. It requests `get_desktop_state(max_image_dimension:0)`, checks display/raster geometry and extracts only that region. A small Sharp processor optionally downsizes it with Lanczos3. No image is artificially enlarged.

Display detail defaults to long-edge cap 1200 and scale 1. Bounds are 64..4096 and 0.05..1; effective cap is `floor(maxLongEdge * scale)`. These per-request settings do not change the shared 500px overview settings. Full-resolution intermediate display pixels stay local to that call and are not forwarded to the model or Vision debug.

Only geometry metadata is retained between calls. A new overview replaces its source's previous context. A dispatched detail consumes that context, so another detail needs a new overview. Missing/retired IDs, rectangles outside the original overview and nested details refuse. Window geometry changes do not retire an overview. Display detail still checks its distinct display/raster mapping; neither route guesses DPI or captures a wider fallback.

## Read-only boundary

These new window/display details grant **no input**. A window detail disarms its earlier input observation; take a new overview before input. Display details have no window reference or input observation.

Safe denies display overview and detail. Permissions, cancellation and window lifetime are checked around awaited native work; display permission/cancellation is checked again after crop processing. Revoked pixels and private intermediate diagnostics are withheld. Only the user changes Safe/YOLO.

Fresh capture is not proof of fresh paint. External changes can occur between native checks; the adapter does not claim an atomic desktop transaction.

## Preview and verification

Vision debug mirrors the exact final PNG/JPEG and source/region/settings metadata. Display detail reports native extraction bounds and output pixels separately. It does not publish the intermediate full-size capture or prove final provider delivery.

```sh
npm test
npm run typecheck
npm run test:integration
```

Check native detail live in a Pi session on newly opened disposable windows, such as Notepad or Calculator, and close them afterwards. Display detail needs explicit permission to read all visible primary-display contents. Keep private display artifacts in the ignored `.tmp/` directory; publish only redacted metadata.
