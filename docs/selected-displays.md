# Selected Windows displays

`computer_displays` lists native connected monitors. `computer_observe` reads one returned `display_ref` or a fresh crop of that monitor. Both are read-only and YOLO-only. They never authorize desktop input.

Selected reads need an explicitly qualified Windows runtime. The older default, held-path and key-hold profiles refuse them before native dispatch. The exact Windows fork `38f50121` passed build, contract and live two-monitor checks. The owner approved keeping it in a separate folder; older builds were preserved. See [verification and limits](selected-displays-results.md). Runtime selection remains explicit; there is no automatic install or update.

## Discover, read, then crop

```js
const listed = await tools.computer_displays({});
text(listed.state);
// Choose a monitor from this result, then store its actual display_ref as "monitor".
```

The result includes `display_id`, native monitor handle/interface paths, physical `bounds`, `work_area`, `primary`, native `scale_factor` and `dpi`. Missing scale stays null. DPI is currently unknown; it is not calculated from scale. `display_id` identifies a Windows logical monitor in that topology, not a permanent hardware serial.

```js
const view = await tools.computer_observe({display:load("monitor")});
text(view.source); image(view.image);
store("monitor_image", view.agent_image.image_id);
```

Choose a rectangle from the returned overview. Its pixels start at `(0,0)` even when the monitor's host-global bounds have negative coordinates. Do not add the monitor's desktop offset or multiply the crop by Windows scale.

```js
const detail = await tools.computer_observe({display:load("monitor"),
  zoom:{image_id:load("monitor_image"),x:100,y:80,width:100,height:80,maxLongEdge:1200}});
store("monitor_image",null);
text(detail.source); image(detail.image);
```

The rectangle above is an example, not a target. Detail consumes that monitor's latest overview and cannot nest. Each selected monitor keeps its own latest overview. A rectangle or image ID from another monitor refuses before capture.

CUA captures fresh full-resolution pixels of the exact selected monitor. The adapter crops and resizes them; full intermediate pixels are withheld. No saved original, second capture backend or primary fallback is used. Codemode forwards only images explicitly emitted with `image`.

## Identity and limits

A native topology token covers monitor identity, physical bounds, work area and scale. Native capture checks it before and after the read. Missing or changed targets refuse without pixels. Rediscovery replaces old references after a topology change. Close/reload retires all references.

Selected source metadata reports `selected_display` or `selected_display_region`, display-local image/crop coordinates and host-global native bounds separately. Only exact native display reads report monitor membership. Window membership remains unknown; proximity to a monitor is not evidence.

`display:"primary"` keeps the existing primary-read route. It does not select an enumerated monitor by a permanent identity. `computer_sequence` still accepts only windows or primary; selected-monitor sequences are outside this change.

Safe denies discovery, overview and detail. Revoked or cancelled reads withhold metadata/pixels. Paint freshness remains unverified. No selected-display input, window relocation, virtual-desktop management or concurrent-agent arbitration is added.

The installed optional human-only Qt overlay supports primary and windows, not selected monitors. Selected reads clear its old mark instead of drawing a misleading primary outline. This does not change the returned image or debug viewer.
