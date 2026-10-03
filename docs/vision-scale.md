# Agent image size

[LPT-375](https://linear.app/alexshpunt/issue/LPT-375) adds physical PNG downsampling to the owned-browser tool path. It does not resize general desktop images or change cache, provider detail, model context or Safe/YOLO.

## Controls

Open the session's Vision debug URL (`/computer-debug status`). The panel has:

- **Downsampling:** Lanczos2, Lanczos3, Mitchell or MKS2021.
- **Max long edge:** 64–4096 pixels; initial value 500.
- **Scale:** 0.05–1; initial value 1. A slider and synchronized numeric box accept precise values such as 0.625.
- **Apply to next capture:** validate and apply the whole tuple together.

The cap is `floor(maxLongEdge × scale)`. For 800 and 0.5 it is 400 pixels. The whole image fits within that cap, keeping its aspect ratio to pixel rounding; small images are not enlarged. PNG encoding is fixed. MKS2021 is the chosen default for the 500px overview. A small 400px experiment scored 7/12 twice with MKS2021 and 6/12 with each other kernel; this is not a universal readability ranking or a guarantee for small text.

Settings apply to the next operation's capture, including image-only observations and action screenshots. An operation snapshots the tuple before dispatch; a panel edit during input or capture affects the following operation, never half of the current frame. Historical frames retain their original settings version and bytes. Panel polling does not overwrite an unsubmitted edit or collapse unchanged expanded action rows.

Reload and a new Pi session restore defaults. Stopping the debug viewer does not disable the browser's image processing or change its settings. No persistent machine configuration is added.

## Coordinates and originals

`click:{x,y}` and `move:{x,y}` use the **last returned agent PNG's pixels**. The parent bridge applies that frame's CSS-rectangle/output ratios and crop offset exactly once before passing source CSS coordinates to the Windows worker. PNG raster dimensions can differ by a rounding pixel; reported `sourceCss` geometry, not that extra raster pixel, controls input mapping. Existing freshness, viewport/scroll/zoom and target checks still run. Compact input retires pixel freshness; capture again before another point action.

Region requests continue to use **source viewport CSS rectangles**. A crop is also physically bounded, and its returned image coordinates are translated back to the full viewport. This task does not replace the crop backend or claim to finish LPT-377.

Each result reports `agent_image`: frozen configuration/version, effective cap, source/output hashes, actual dimensions, bytes, mapping and stage timings. The `screenshot` field still describes the source CSS viewport, not the resized PNG. Normal full observations include this metadata in their text; image-only results keep pixels only, with metadata available in structured results.

The original is the exact **pre-resize captured PNG**, which can already include hint overlays. It is not a fabricated second capture or a promised clean pre-overlay image. Six recent distinct originals are retained by hash, within 48 MiB, with a 12 MiB per-source limit. The viewer links retained originals separately; old links can expire. Debug frame bytes have their own existing bounded store. Final provider delivery and internal model preprocessing remain unconfirmed.

Processing runs in the parent Pi process, not in a new Windows service. Timings separate source decode/header work, spatial resampling and fixed PNG encoding. Browser bridge timings and model thinking are different costs.

## Reproduce checks and experiments

- `npm test` and `npm run typecheck` protect dimensions, no enlargement, four actual kernels, tuple validation, frozen settings, point/crop mapping, polling and server security.
- `npm run test:integration` includes a native loopback provider adapter that receives the real Pi tool/Codemode PNGs at the default 500 and an edited 400 pixels and checks source-mapped input. It uses no paid model calls.
- `node --experimental-transform-types scripts/verify-vision-scale.mjs` runs an opt-in synthetic Windows browser check, including real panel dropdown/slider/size input and cleanup.
- `node scripts/benchmark-vision-images.mjs <original.png> [directory]` compares all four kernels at caps 800, 600, 400 and 200. One explicit local processing warm-up and five measured runs per candidate; no model/cache warming. It saves images, hashes, bytes and stage medians.
- `node --experimental-transform-types scripts/verify-vision-trial.mjs` exercises the actual trial form, twelve fields, exact scale input/slider synchronization, grading, cleared inputs and the next capture's physical size. Its deliberately wrong answers test the UI contract, not model readability.

## Interactive reading trial

Use **Open the random text reading trial** in Vision debug. The same private server hosts two separate columns of six independent random strings each: white on the left, dark on the right. There are twelve answer fields, no confidence selectors, and resizing controls including the precise scale box. Each half of the 980×480 source PNG has font sizes 28, 20, 16, 12, 10 and 8 px and fine lines. CSS fitting and the viewport size also affect the final pixels; record actual image metadata, not just nominal font size.

Read the actual agent image only. The expected phrases and digits stay in server memory, never in DOM text or a JSON answer field. Enter each string without its row number. Matching is exact, including case and spaces; an empty or different answer fails. **Apply: check and new trial** grades all twelve fields, keeps the previous result, applies the settings and immediately creates new unpredictable text. Inputs clear. Correct answers are never revealed, and a trial cannot be graded twice. No manual answer JSON files are needed.

In Codemode, submit with `observe:false`, then capture again. Forward the PNG only after its metadata matches the selected settings and the page shows a new ready trial. Apply can finish during an observation that already froze the previous settings: discard that image and retry a bounded observation without repeating Apply. A fixed pause is not proof of readiness. Do not forward the automatic Apply screenshot as a smaller trial. Generic control discovery is safe because the sample has no DOM answer text. Do not read source PNGs, OCR, hidden state or expected answers to complete the trial.

The server keeps six active samples and sixteen grades, in memory only. Reload expires them. Private loopback/session URL, Host/Origin, JSON shape and body-size checks also cover grading. A grade lists statuses, not expected or submitted text. Saved tool images and their model/settings metadata provide separate durable evidence.

The first comparison is interactive, not a paid model matrix. A measured boundary belongs to the tested page, font, source size, settings and model; repeat observed mismatch boundaries before claiming a threshold. Four-kernel pixel/timing comparisons are not a model-readability ranking.
