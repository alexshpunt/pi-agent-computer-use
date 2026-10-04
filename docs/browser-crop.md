# Original-frame browser crop

Use saved detail through the existing Pi CodeMode browser surface:

```js
const detail = await tools.browser_observe({
  crop: { x: 45, y: 40, width: 250, height: 90, maxLongEdge: 1200, scale: 1 }
});
image(detail.image);
text(detail.agent_image.origin);
```

The rectangle uses pixels of the **last returned agent image**, not CSS pixels. For nested crop, use the last crop's pixel coordinates. No page or observation ID is required.

Saved crop checks the owned focused tab, but does not take another screenshot or read page text. It extracts the retained original PNG before resampling. Nested crops still extract the same original, never enlarge an earlier downsampled result.

## Detail settings

`maxLongEdge` is optional, integer64..4096. `scale` is optional,0.05..1. The output cap is floor(maxLongEdge × scale). Missing values use the current session settings; a request does not change them. MKS2021/500/scale1 remains the default overview. To retain more detail, choose a larger local long edge. Small original regions are not enlarged. Output PNGs are bounded to12MiB.

Invalid or out-of-bounds rectangles refuse; they are not silently clipped. Fractional image coordinates are allowed. The source raster rectangle rounds outward to cover whole original pixels; metadata reports the exact rectangle actually extracted.

## Source and freshness

`agent_image.source` identifies the root original PNG, including its full raster dimensions and hash. `origin` contains:

- `kind`: `saved_crop` or `fresh_capture`;
- `observation`: immutable root capture identity, also used by nested crops;
- `raster`: extracted rectangle in root-original PNG pixels;
- `css`: the same rectangle in the captured page's viewport CSS coordinates;
- `inputReady`: no intervening agent input has consumed coordinate readiness. This is not a guarantee against asynchronous page changes; the backend still validates document/viewport/scroll/zoom immediately before input.

`output` reports actual returned PNG dimensions and hash. `mapping` maps that PNG's points back to captured CSS coordinates. Coordinate clicks use the last image, including crops.

Compact input retires coordinate readiness. Saved historical detail can still be inspected, but cannot restore input permission. Request a fresh observation before acting on coordinates. Focus changes, new observations, close or worker retirement discard saved crop access; evicted originals refuse. Saved crop cannot launch a new browser. No arbitrary resource IDs, filesystem paths or personal pages are accepted.

## Fresh region is different

```js
const fresh = await tools.browser_observe({
  region: { x: 100, y: 130, width: 100, height: 80 }
});
image(fresh.image);
```

`region` takes a **new** screenshot of a rectangle in source viewport CSS pixels. It is not saved crop or page zoom. It cannot be mixed with `crop` in one request. A fresh region establishes a new original observation.

`screenshot` consistently reports full viewport CSS dimensions. Actual PNG raster dimensions are in `agent_image.source`; they may differ by a pixel at display scaling. The old region regression mixed these two dimensions in the same field. Resizing does not replace historical geometry with current geometry.

## Verification

- `npm test`, `npm run typecheck`, `npm run test:integration`.
- `node --experimental-transform-types scripts/verify-browser-crop.mjs`: opt-in owned Windows browser on synthetic pages. Checks direct original extraction, nested detail, point input, stale/history refusal, fresh region, focus/close, cancellation, CSS/raster metadata, resize/scroll/navigation and owned cleanup.
- `node scripts/crop-fixture.mjs`: disposable local pixel-only reading page for live parent checks. It prints its URL and saves it in `.tmp/crop/fixture.json`. Stop its owned terminal after closing the test browser.

The debug viewer shows the actual returned image, effective origin/geometry and its separately retained original. It observes the application boundary, not guaranteed final provider delivery. General desktop/display crops, context eviction and game completion remain separate tasks.
