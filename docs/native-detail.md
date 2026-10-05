# Window zoom and display detail

CUA 0.33.2 is the qualified Windows runtime for window, display and browser tools. It remains unmodified. Native window zoom is reused directly; the driver still has no display-region capture, so our adapter crops a fresh full-resolution display PNG.

Use existing `computer_observe` and Pi Codemode. No new executor or top-level tool is added.

## Select from an overview

First read one source:

```js
const overview = await tools.computer_observe({display:"primary"});
text(overview.source);
text(overview.agent_image.image_id);
image(overview.image);
```

Then select a rectangle from that returned PNG, not from remembered pixels or CSS coordinates:

```js
const detail = await tools.computer_observe({
  display:"primary",
  zoom:{image_id:overview.agent_image.image_id,
        x:100,y:80,width:100,height:80,maxLongEdge:1200,scale:1}
});
if (detail.status !== "observed") {
  text(detail.text);
} else {
  text(detail.source);
  text(detail.agent_image);
  image(detail.image);
}
```

The example coordinates are illustrative: use the current image's actual bounds. A separate Codemode call can retain the overview ID with `store`/`load`. Structured observation results report refusals through `status`; check it before continuing.

For a desktop window, substitute `window_ref` for `display` and omit `maxLongEdge`/`scale`. Use the image ID from that window's latest overview. Window zoom is CUA's fresh JPEG with native padding and a 500px width limit; height can exceed 500. There is no automatic foregrounding or display fallback. Browser zoom and its input contract are unchanged.

## Fresh pixels, not a saved crop

Window detail calls native `zoom` with the original overview rectangle. Moving, shrinking, growing or changing scale does not invalidate that request. CUA keeps the original screenshot-to-native scale, captures fresh window pixels, and clips its padded crop to the current raster. Growth does not stretch or expand the requested region. The human frame uses the current window origin and clips the original local region to current bounds. Window lifetime, permission and cancellation are separate checks. JPEG padding and mapping belong to CUA; its response does not expose the native crop origin, so that origin stays null.

Display detail maps the overview rectangle to native pixels once, rounding outwards. It requests `get_desktop_state(max_image_dimension:0)`, checks display/raster geometry and extracts only that region. A small Sharp processor optionally downsizes it with Lanczos3. No image is artificially enlarged.

Display detail defaults to long-edge cap 1200 and scale 1. Bounds are 64..4096 and 0.05..1; effective cap is `floor(maxLongEdge * scale)`. These per-request settings do not change the shared 500px overview settings. Full-resolution intermediate display pixels stay local to that call and are not forwarded to the model or Vision debug.

Only geometry metadata is retained between calls. A new overview replaces its source's previous context. A dispatched detail consumes that context, so another detail needs a new overview. Missing/retired IDs, rectangles outside the original overview and nested details refuse. Window geometry changes do not retire an overview. Display detail still checks its distinct display/raster mapping; neither route guesses DPI or captures a wider fallback.

## Read-only boundary

These new window/display details grant **no input**. A window detail disarms its earlier input observation; take a new overview before `computer_act`. Display details have no window reference or action observation ID.

Safe denies display overview and detail. Permissions, cancellation and window lifetime are checked around awaited native work; display permission/cancellation is checked again after crop processing. Revoked pixels and private intermediate diagnostics are withheld. Only the user changes Safe/YOLO.

Fresh capture is not proof of fresh paint. External changes can occur between native checks; the adapter does not claim an atomic desktop transaction.

## Preview and verification

Completed verification: [LPT-407 results](native-detail-results.md).

Vision debug mirrors the exact final PNG/JPEG and source/region/settings metadata. Display detail reports native extraction bounds and output pixels separately. It does not publish the intermediate full-size capture or prove final provider delivery.

```sh
npm test
npm run typecheck
npm run test:integration
# Explicit permission to read all visible primary-display contents is required:
node --experimental-transform-types scripts/verify-native-detail.mjs --allow-primary-display
```

The opt-in check uses newly owned Calculator/browser fixtures, closes them and releases their runtimes. Private display artifacts remain in ignored `.tmp/native-zoom/`; only redacted metadata may be published.
