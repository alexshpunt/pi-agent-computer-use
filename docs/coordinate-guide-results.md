# Overview coordinates and image guides: Windows results

LPT-378 and LPT-379 passed the approved native/current-agent scope. This is not a multi-model benchmark. Six production `computer_*` tools remain the only app interface; CUA remains the capture/input backend.

## Measured targeting

The owned native/browser matrix recorded 18 application pointer hits: each route at 500, 800 and 1024px long-edge caps, before and after movement and resizing. Every case used a fresh input overview. Native error was at most one physical pixel per axis. Browser error was at most 0.771 CSS pixels per axis. Native fixture DeviceDpi was 96; browser DPR was 1.5. These are separate measurement domains, not cross-DPI qualification.

After Pi reload, the current agent separately chose four target centers from actual production PNGs through Codemode:

| Route | Returned PNG | Application hit error per axis |
| --- | --- | --- |
| Native | 500×426 | 0, 0 native screen pixels |
| Browser | 466×500 | −0.010, −0.563 CSS pixels |
| Browser | 746×800 | −0.010, +0.771 CSS pixels |
| Browser | 955×1024 | +0.656, +0.771 CSS pixels |

Application counters and passive native MouseUp/browser PointerEvent records witnessed the hits. CUA received returned-window-image coordinates once. Browser receipts supplied native resolved points; the native fixture's receipt omitted them, so application measurements were used without inventing a driver point. No completed or uncertain input was replayed. These small synthetic samples do not measure general agent performance.

## Actual guide output

- The final 500px native PNG had readable grid numbers on the opposite edges when the titlebar or controls blocked the usual edge. Three labels were explicitly omitted. Collected control rectangles and badges stayed clear; uncollected headings cannot be protected.
- Local `ui.region` marked the rectangle chosen from that PNG with an amber border on the same stored raw image. It preserved observation authority. The following native detail returned a fresh 500×200 JPEG and consumed that authority. Detail remained read-only.
- One exact native Save hint click produced an actual application count and a visible pink target border on the next overview. This border marks the collected control rectangle, not a measured cursor.
- Native pixel input without a usable native point left the action guide unavailable. Browser point receipts were proven, but the small borders were entirely covered by the known Canvas rectangle; they were explicitly unavailable rather than painted over its contents.
- Grid/region/action switches were changed through the owned browser's native UI. Later captures used the new tuple. With all switches off, a retained earlier viewer card still showed its original grid. The final volatile setting was restored to 1024/1 with all optional guides off. Per-capture options remain independent.

Exact private raw/sent exports independently checked file SHA256 and PNG dimensions. The [redacted evidence](evidence/coordinate-guides/run.json) contains hashes, sizes, guide statuses and measurements, not private pixels, UI text, window identities or viewer URLs. Only one marked image is returned to the agent. Application-boundary image bytes are not proof of final transport delivery.

The existing raw/sent selector was not changed. New live selector attempts did not establish a selected raw mode while the viewer's three cards rolled during self-observation; they are not recorded as a pass. Exact retained raw/sent assets were checked through the private viewer's read-only export, and unavailable assets were explicitly reported. The earlier selector qualification remains in [UI-resource results](ui-resource-results.md). Normal Pi image retention, compaction and caching are unchanged.

## Detail and source boundaries

The window detail route was not changed. The [LPT-415 geometry proof](region-highlight-results.md) remains the native move/shrink/grow evidence: original local region and scale, fresh clipping on shrink, no expansion on growth and no bounds-equality invalidation. This run also returned fresh production detail. Deterministic detail/display extraction, consumed-observation, identity, access and cancellation contracts passed in the full suite. No inverse input mapping is claimed for CUA's unpublished padded JPEG origin.

## Checks, failures and cleanup

227 unit tests, TypeScript checking, 13 real-Pi tests and diff checks passed. Reload exposed exactly six computer tools and zero browser tools. The actual 77×57 human TUI viewport showed readable action/verification text and the unchanged YOLO footer. Images were collapsed by the normal terminal renderer; no inline-image claim is made.

Early fixture attempts failed because Save had no pointer witness and Panel/Label nodes were not indexed. A read-only textbox target supplied native coordinates without another input backend. Regression failures also exposed hidden X-axis labels, false fractional clipping metadata and false pixel grounding on keyboard-only input; their focused fixes passed. All failed runs remain failures.

Viewer scrolling sometimes returned tree coordinates before its pixels settled. Bounded read-only observations resolved the mismatch; delivered input was not treated as paint proof. No unrelated window was used. Both parent fixtures and matrix fixtures closed; the disposable browser profile was removed. Driver/helper counts were zero, and read-only Windows checks found all mouse buttons and Ctrl/Shift/Alt/Win released. The user's game and unsaved Paint were preserved.

Runtime source `3b3305044b7b327310615aa99d3307948a63061c` and EXE SHA256 `9786ace009b81fb2555f14f64b605ab20c3bfc309493398424be1183532df749` stayed unchanged. No OS DPI, permissions, dependencies, backend or IDE setup changed. Other epic work stays paused.
