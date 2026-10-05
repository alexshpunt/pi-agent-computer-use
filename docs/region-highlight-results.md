# Region and action highlights: Windows results

LPT-415 adds human-only marks to the existing Qt helper: cyan overview, amber requested zoom/crop, and pink action target. Each flash lasts two seconds and replaces the previous mark. CUA 0.33.2 remains the unmodified capture/input backend. Production tools remain the six `computer_*` tools.

## What passed

- The native run made 20 CUA calls and recorded 210 checks, including repeated human-demo flashes. All six renderer cases passed native focus checks and pixel-identical captures of the owned region: window/display overview, window zoom/display crop, AX rectangle and pixel point.
- The helper hid expired and stale frames. One AX action and one pixel action were dispatched once each; the fixture showed selection counts 1 then 2. No input was replayed.
- The user confirmed all three colors on the real screen, physical click/typing passthrough and no helper focus theft.
- After the final extension reload, parent Pi Codemode returned the actual 500×357 PNG and 500×113 read-only JPEG. The private viewer exported exactly those bytes and preserved source/region metadata. [Redacted evidence](evidence/region-highlights/run.json) records their hashes, not their pixels or text. The viewer's delivery field remained `unconfirmed`; exported bytes alone are not a transport-delivery assertion. The model separately read both returned images.
- The actual human TUI viewport showed readable `Human mark` overview/detail summaries (pane w3E9:p7, revision 413). Stock collapsed output hid the images; this is not an inline-image rendering claim.
- Reload reset the volatile image setting to 500/1. The owned viewer restored the user's 1024/1 setting; a fresh overview was 1024×731. No persistence feature was added.
- Owned fixture window/browser, Driver, helper and disposable profiles were gone after cleanup. The existing game window was preserved. An orphan profile was removed only after its native ownership marker and two local fixture/viewer history entries proved it belonged to this test.

## Window geometry correction

The parent run exposed a real adapter defect: moving the same window between overview and detail tripped our bounds-equality gate. That gate is removed for read-only window detail. Window identity, permission and cancellation checks remain; geometry is not window lifetime.

Detail uses fresh native CUA pixels, the original window-local rectangle and retained screenshot scale. It clips smaller current bounds and never expands the requested region when the window grows. The human mark uses current screen position with that original local mapping. No saved-image crop, replacement overview or driver patch was added.

Four controlled native cases passed without an intervening overview after placement changed:

| Case | Native JPEG | Requested human mark |
| --- | --- | --- |
| Baseline | 500×334 | 479×320 |
| Move | 500×334, same hash | 479×320 at the new position |
| Shrink | 358×325 | clipped to 263×262 |
| Grow | 500×334, same hash | 479×320, not stretched |

The static fixture's baseline/move/grow images had identical hashes; this is not a guarantee for changing page content. Live OS scaling was not changed. The retained-scale rule has regression coverage, but there is no cross-DPI or cross-platform qualification claim.

## Failures fixed and limits

- Fractional DPI rounded Qt's own canvas to 2561px for a 2560px display. The helper now allows only bounded outward canvas rounding and clips drawing to the exact source. Source and input authority were not widened.
- An old helper could ignore new region fields. Protocol 2 is required instead of accepting a misleading whole-window acknowledgement.
- Native input refusals with `isError:false` are treated as refusals, not delivered actions.
- Failed harness runs remain failures. The harness was corrected for a 500px cap returning 499px, DPI-virtualized fixture placement, fixture target filtering and result shape.

Window zoom marks show the requested region, not CUA's unpublished extra padding. A unique native mapping is required; missing or ambiguous mapping clears the mark and reports unavailable without withholding a successful capture. Pixel marks require a recognized successful native receipt; they never guess a point or retry input. A mark already on screen hides if its source moves or resizes; the next successful detail draws against current bounds. Hiding the old drawing does not invalidate the window or read-only detail.

This is Windows x64 qualification only. Capture success does not prove current paint. A `shown` reply alone does not prove human visibility, click-through or exclusion; those were checked separately here.

## Build and checks

The installed Qt 6.11.3 protocol-2 helper SHA256 is `c79a10981ab3e345a10950f90858224fdbad34ad43db5215451cc95586980b01`. Its six runtime files total 27,491,067 bytes. The matching 53-file source/license package totals 99,414,827 bytes. See [deployment and licensing](window-overlay.md) and the [earlier startup/RAM measurements](window-overlay-results.md).

115 unit tests, TypeScript checking and nine real-Pi tests passed after the geometry correction. Native probes, private-byte exports and read-only cleanup passed separately. Reusable probes are `scripts/verify-region-highlights.mjs`, `scripts/verify-window-zoom-geometry.mjs` and `scripts/check-region-highlight-cleanup.mjs`. `scripts/export-region-highlight-evidence.mjs` verifies private artifacts and exports only allowlisted metadata. Private display/window images, text, identities and viewer URLs are not published.
