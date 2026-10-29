# Selected Windows displays

See [the resource guide](computer-resources.md) for the current addresses, views and commands.

A machine's `displays` address lists native connected monitors. A display Read returns one monitor's overview, or a fresh crop of it from its observation. Both are read-only and YOLO-only. They never authorize desktop input.

Selected reads need an explicitly qualified Windows runtime. The older default, held-path and key-hold profiles refuse them before native dispatch. The exact Windows fork `38f50121` passed build, contract and live two-monitor checks. The owner approved keeping it in a separate folder; older builds were preserved. Runtime selection remains explicit; there is no automatic install or update.

## Discover, read, then crop

The display list includes `display_id`, native monitor handle/interface paths, physical `bounds`, `work_area`, `primary`, native `scale_factor` and `dpi`. Missing scale stays null. DPI is currently unknown; it is not calculated from scale. `display_id` identifies a Windows logical monitor in that topology, not a permanent hardware serial.

Choose a rectangle from the returned overview. Its pixels start at `(0,0)` even when the monitor's host-global bounds have negative coordinates. Do not add the monitor's desktop offset or multiply the crop by Windows scale.

Detail consumes that monitor's latest overview and cannot nest. Each selected monitor keeps its own latest overview. A rectangle or image ID from another monitor refuses before capture.

CUA captures fresh full-resolution pixels of the exact selected monitor. The adapter crops and resizes them; full intermediate pixels are withheld. No saved original, second capture backend or primary fallback is used. Codemode forwards only images explicitly emitted with `image`.

## Identity and limits

A native topology token covers monitor identity, physical bounds, work area and scale. Native capture checks it before and after the read. Missing or changed targets refuse without pixels. Rediscovery replaces old references after a topology change. Close/reload retires all references.

Selected source metadata reports `selected_display` or `selected_display_region`, display-local image/crop coordinates and host-global native bounds separately. Only exact native display reads report monitor membership. Window membership remains unknown; proximity to a monitor is not evidence.

`computer:machine/<name>/display/primary` keeps the primary-read route of that machine. It does not select an enumerated monitor by a permanent identity. A listed display's address is `computer:machine/<name>/display/<ref>`; its reference is unknown on any other machine. Temporal sequences accept windows, a machine's primary display and its listed displays.

Safe denies discovery, overview and detail. Revoked or cancelled reads withhold metadata/pixels. Paint freshness remains unverified. No selected-display input, window relocation, virtual-desktop management or concurrent-agent arbitration is added.

The installed optional human-only Qt overlay supports primary and windows, not selected monitors. Selected reads clear its old mark instead of drawing a misleading primary outline. This does not change the returned image or debug viewer.
