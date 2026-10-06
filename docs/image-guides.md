# Overview coordinates and optional guides

Use points in the returned window PNG. CUA applies the native transform once; do not add the desktop origin or divide by DPI yourself. Display pixels, browser CSS pixels and native screen pixels are different spaces. Detail JPEGs are read-only: CUA does not publish their padded crop origin, so no inverse input mapping is claimed.

## Request guides

All three guides are off by default. Enable a full tuple for one native capture:

```js
const view = await tools.computer_observe({window_ref:load("task_window"),
  capture:{guides:{grid:true,region:true,action:true}}});
store("task_observation",view.observation_id);
store("task_image",view.agent_image.image_id);
text(view.agent_image.annotation.guides); image(view.image);
```

The dashed grid labels are actual overview pixel coordinates, not a new target format. Thin lines and labels avoid collected control rectangles and existing hint badges. Missing native controls cannot be protected. Dense areas may hide labels or borders; inspect the placement metadata instead of guessing.

Mark a rectangle chosen from the image before requesting detail:

```js
const marked = await tools.computer_observe({window_ref:load("task_window"),
  ui:{operation:"region",observation_id:load("task_observation"),
    region:{x:100,y:80,width:120,height:60}}});
text(marked.agent_image.annotation.guides); image(marked.image);
```

These numbers are examples, not targets. The rectangle must fit the overview. This local operation preserves its input authority and aliases, and draws an amber border on its exact stored raw pixels. It does not capture detail. A later zoom/crop still consumes input authority; observe again before input.

The pink last-action border is available only after a delivered pointer command with usable native target geometry. A token marker names the collected target rectangle, not a measured cursor position. Pixel clicks need a native resolved-point receipt that agrees with the observed transform. Missing geometry, refusal or uncertain delivery never manufactures a completed marker. A new native overview reprojects proven window-local geometry and clips it to the image. Movement alone is not window invalidation.

## Private comparison

The private viewer has separate grid, region and action switches. They affect later captures only; a capture tuple overrides the shared setting. Older sent images and settings remain frozen. Exact raw and sent PNGs have unchanged dimensions; only one annotated image is sent to the agent. Human-only screen flashes are separate.

`agent_image.annotation.guides` reports each guide's status, available region, clipping, spacing and omitted-geometry reason. Action results report the input domain and native resolved point where available. Unknown mapping stays unknown. Keep private images and window text out of public evidence.
