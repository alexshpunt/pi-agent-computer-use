# Overview coordinates and optional guides

Use points in the returned window PNG. CUA applies the native transform once; do not add the desktop origin or divide by DPI yourself. Display pixels, browser CSS pixels and native screen pixels are different spaces. A DPI-unaware app on a scaled display paints at 96 DPI and Windows stretches it on screen; its overview is stretched the same way, so its UI bounds, OCR boxes and points match the image like any other window's. Detail JPEGs are read-only: CUA does not publish their padded crop origin, so no inverse input mapping is claimed.

## Request guides

Both guides are off by default. Enable the full tuple for one window Read:

```js
const view = await tools.read({ path: window,
  views: ['capture:{"guides":{"grid":true,"action":true}}'] });
image(view);
```

Without Pi Agent IDE, use `computer_read` with the same arguments.

The dashed grid labels are actual overview pixel coordinates, not a new target format. Thin lines and labels avoid collected control rectangles and existing hint badges. Missing native controls cannot be protected. Dense areas may hide labels or borders; inspect the placement metadata instead of guessing.

The pink last-action border is available only after a delivered pointer command with usable native target geometry. A token marker names the collected target rectangle, not a measured cursor position. Pixel clicks need a native resolved-point receipt that agrees with the observed transform. Missing geometry, refusal or uncertain delivery never manufactures a completed marker. A new native overview reprojects proven window-local geometry and clips it to the image. Movement alone is not window invalidation.

## Private comparison

The private viewer has separate grid and action switches. They affect later captures only; a capture tuple overrides the shared setting. Older sent images and settings remain frozen. Exact raw and sent PNGs have unchanged dimensions; only one annotated image is sent to the agent. Human-only screen flashes are separate.

`agent_image.annotation.guides` reports each guide's status, available region, clipping, spacing and omitted-geometry reason. Action results report the input domain and native resolved point where available. Unknown mapping stays unknown. Keep private images and window text out of public evidence.
