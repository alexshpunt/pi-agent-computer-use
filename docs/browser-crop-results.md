# Original-frame crop results

LPT-377 passed on the owned visible Windows browser from WSL. No personal pages, desktop input, IDE changes or game actions were used.

## What passed

- Saved crop uses the last returned PNG's coordinates and extracts the retained original before resizing. Nested crop keeps the same source hash and observation identity. Native checks compare decoded pixels against direct original extraction, not a screenshot of an enlarged overview.
- Per-request `maxLongEdge` and `scale` stay local. MKS2021/500/scale1 remains the overview default; small original regions are not enlarged.
- Invalid bounds, mixed fresh/saved options, missing or retired sources refuse. Compact input leaves historical detail readable but cannot restore coordinate input. Focus, close and worker retirement discard crop access. Native resize, external scroll and navigation refuse old coordinate input before a click.
- Real Pi CodeMode forwards actual crop PNGs. Its fixture records one initial capture, no extra captures for saved detail, and no stale coordinate dispatch. Debug records retain crop origin and the separately available original.

## The viewport regression

The unchanged region runner reproduced 1086 versus 1085. Full observation reported PNG raster width while region reported viewport CSS width. These are distinct spaces at fractional Windows display scaling; the viewport had not changed.

Full and region observations now report CSS dimensions consistently. `agent_image.source` separately reports actual original raster dimensions. The equality safeguard remains. The selected runner explicitly requests a full observation after its click because committed actions remain compact; it does not remove or weaken the failing viewport assertion.

Evidence: [failure](evidence/browser-crop/region-failed.json), [first corrected run](evidence/browser-crop/region-first-fixed.json), [selected revision regression](evidence/browser-crop/selected-region.json).

## Parent image and preview check

After extension reload, the parent opened a synthetic pixel-only page through the browser tools in CodeMode. No DOM answer, OCR or source truth was read.

| Returned image | Size | Root raster rectangle |
| --- | --- | --- |
| [Overview](evidence/browser-crop/overview.png) | 500×325 | 0,0,1085,706 |
| [Detail](evidence/browser-crop/detail.png) | 611×190 | 95,95,611,190 |
| [Nested](evidence/browser-crop/nested.png) | 360×90 | 110,155,360,90 |

All three share the same original and root observation. [Parent metadata](evidence/browser-crop/parent.json) records their hashes, immutable geometry and local settings. The saved detail made the three strings readable: `Original pixels 26509860`, `Small detail 53055198`, `Fine print 11219131`. This is a qualitative reading check, not a graded recognition benchmark.

The [actual debug viewer](evidence/browser-crop/preview.png) showed the prepared 611×190 and 360×90 images with matching output hashes, `saved_crop`, original availability and root origin. Its controls remained MKS2021/500/1. The nested PNG was also visible in the viewer after scrolling. The viewer observes application image boundaries, not guaranteed final provider delivery.

`inspect_tui` captured the real human viewport, Herdr w3E9:p6 revision3043. Calls and text were readable; stock collapsed rendering hid inline PNGs. Browser/debug preview supplied the visual surface. No inline-image claim is made.

## Verification and scope of the commit

The working tree passed 73 unit tests, typecheck, six real-Pi contracts and 25 native records. The selectively staged snapshot was exported to an ignored temporary directory and independently passed 66 unit tests, typecheck, six real-Pi contracts, 25 native crop records and six region records. Its native detail and nested PNGs were visually checked too.

- [Working native records](evidence/browser-crop/working-native.json)
- [Selected snapshot native records](evidence/browser-crop/selected-native.json)

The different unit counts are intentional: unfinished LPT-372 stable-hint, pointer-move, default-action-image and target-filtering work was excluded. Only the fresh-region foundation needed by this task was selected. That other work remains in the current workspace, not silently included in this commit.

Both native runs and the parent cleanup ended with zero owned browser roots, workers and profiles. The parent fixture server was stopped. The normal debug server remains session-owned.

## Limits

Saved detail is historical pixel data, not live page state. `inputReady` only tracks intervening agent input; the backend still checks document and geometry before coordinate input. Asynchronous page content can change without changing geometry. Evicted originals require fresh capture. General desktop/display crops, cache policy and LPT-372 completion remain separate.

See [the crop API](browser-crop.md) for calls, bounds and lifetime rules.
