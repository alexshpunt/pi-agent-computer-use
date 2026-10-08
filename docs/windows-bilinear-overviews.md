# Windows Bilinear overviews

[LPT-663](https://linear.app/alexshpunt/issue/LPT-663) replaces only the resize filter for capped Windows window, primary-display and selected-display overviews. PNG encoding, capture and input do not change. After isolated qualification and the user's final review, the native fork and extension changes were merged. This installation explicitly selects the exact qualified Bilinear runtime and passed production tool/TUI checks. The previous runtime is retained.

## Native change

The CUA candidate is `4825375a7d7827cd5dcf0f34924aa45611533853`, based on semantic-actions source `ab86b25cba1cb9c6f5025f25fdd7a8cb3cd21a44`. [Merged PR 15](https://github.com/alexshpunt/cua/pull/15) contains the native change. Its merge commit is `bbd0c3e987ad546866e1e23a93911b0433a0b491`; the qualified executable remains the exact candidate-source artifact above.

It pins `fast_image_resize` 6.1.0 with `std` and no default features. Bilinear uses automatic SIMD selection without Rayon. We use its MIT license option; the Windows bundle includes the copyright notice and MIT text in `THIRD_PARTY_NOTICES.md`.

Window pixels still resize before one final PNG encode. Display overviews keep their existing PNG decode/resize/encode route; only resize changes. The old common helper remains Lanczos3 for other platforms, detail and recording.

The candidate preserves:

- Native-size and within-cap PNG bytes.
- The existing two-step aspect fit, rounding and one-pixel minimum.
- BGRA-to-RGBA channel order and independent color/alpha filtering, without introducing premultiplied alpha.
- Snapshot identity, image geometry, input coordinate mapping and image/UI/full granularity.
- Read-only display access and Safe-mode denial.

The extension reports `bilinear` from the trusted `windows-fast-bilinear` profile. It is not an agent-selectable filter. Old profiles report `lanczos3`. Saved observations keep their captured settings; display detail remains Lanczos3.

## Exact Windows artifact

[Windows build 37781719030](https://github.com/alexshpunt/cua/actions/runs/37781719030) passed owner tests, protocol/schema tests and release packaging on Rust 1.97.1/MSVC.

| Item | Value |
| --- | --- |
| Version | 0.34.0 |
| Source | `4825375a7d7827cd5dcf0f34924aa45611533853` |
| Driver SHA-256 | `237cf3f4d32f3dd92a9f99041452e2d755e0d837c92ef76eba2f03e6a36df58c` |
| UIA helper SHA-256 | `ca1aaab866de0c288e726070339b271fe217d02183d31b80f994a415d9168bd2` |
| Cursor helper SHA-256 | `73b17092dc8c067ea5233db9a037a63d74dac34212149b5f256adc7667a05901` |

All three downloaded bytes match the CI manifest. This is an unsigned research build, not an upstream release. Timing-only diagnostic builds must never be selected as production runtimes.

## Verification so far

The exact native Bilinear/reference regression first failed against Lanczos3. Seven focused tests then passed. A final explicit Rust 1.97.1 run passed all 852 core tests. The first red/focused runs used the root Rust 1.98.0 toolchain; they are not evidence for the pinned Windows toolchain.

The overview metadata/viewer regression first failed against the old hardcoded filter. All 341 extension unit tests, typecheck and 24 real-Pi integration tests passed. They cover captured settings, old profiles, wrong-artifact rejection and the fixed viewer selector. The isolated Windows qualifier passed 116 window samples, 24 display samples, three application-witnessed clicks, five read-only details and Safe display denial. After preserving the concurrent runtime-bundling changes, the integrated tree passed 363 unit tests, typecheck and 25 real-Pi tests. Approved runtime selection, reload and production tool/TUI verification then passed.

## Live results

The same new synthetic window used a 1600×1200 host rectangle and a 500px image cap. Ten warm samples per runtime/mode alternated baseline and candidate; two diagnostic builds separately measured native resize including destination allocation, excluding capture and PNG.

| Measurement | Lanczos3 | Bilinear |
| --- | ---: | ---: |
| Native resize median | 15.81 ms | 1.64 ms |
| Image-only capped call mean | 86.77 ms | 70.46 ms |
| Full capped call mean | 109.67 ms | 92.28 ms |
| Native-size call mean | 70.77 ms | 73.91 ms |
| UI-only call mean | 57.33 ms | 55.80 ms |

These are the latest complete paired run: resize was about 9.7× faster, while capped whole calls improved by about 16–17ms. The first complete run measured resize 50.30→4.00ms, image-only 125.48→86.47ms and full 155.68→133.05ms. Workload and source conditions varied; neither run promises a universal speedup. Native-size and UI-only calls do not resize, so their differences are timing variation, not evidence of a resize benefit. Full-call times are SDK receipt times, not compositor frame age or a game latency guarantee.

All 24 capped window traces kept one final PNG encode and no intermediate PNG encode/decode. File delivery without an embedded image or UI tree also passed. The actual 500px window PNG had readable title, canvas text, Save buttons and item labels. Three clicks before/after movement and resize had independent click/pointer witnesses; the largest coordinate error was 0.77 CSS pixels per axis.

Primary and selected-display paths returned matching capped/native dimensions. Only one physical monitor was connected, so selected addressing used that same primary monitor. Its dimensions were 2560×1440 in the first run and 3840×2560 in the latest run; this is not a multi-monitor claim. Legacy two-step rounding produced 499×333 at the 500px cap in the latest run. Two qualification attempts stopped before input because the checker incorrectly required an exactly 500px long edge. Correcting that checker preserved the native implementation and exact baseline/candidate dimension comparison; those runs remain failures.

The initial monitor crops showed other applications, not the occluded fixture, and did not prove fixture readability. The user then approved foregrounding only a new test window. A separate short check used CUA `bring_to_front` and `set_window_frame`, with no fixture-control clicks. The actual 400×267 fixture crops from both capped display paths had recognizable title, canvas, Save buttons, checkbox and item groups. Small labels are less legible than in a window overview; use fresh read-only detail for small text. Intermediate captures caught partially painted content after resizing; the final primary and selected frames were complete and understandable. Capture success is not paint readiness, and changing the resize filter does not fix that timing limit. No whole-monitor image is published; private crops were removed.

The owned fixture/profile, clients, site and temporary candidate copies all cleaned up. Baseline config bytes and the installed baseline executable hash were unchanged. The original WSL endpoint had disappeared, so the experiment used a live endpoint override without writing config. [Redacted samples and checks](evidence/windows-bilinear/run.json) retain timing and geometry evidence without screenshots, native IDs or window titles.

## Adoption and production check

The user approved merge, runtime selection and reload after seeing the results. Extension merge `e4b99d680f2d1bb0f71920069034328e8105d3d1` was pushed to develop. The three config/driver/index conflicts were resolved without removing bundled runtime discovery, hash/schema checks, platform lifetime limits or the Bilinear profile. The bundled default packages and pins remain unchanged; this installation uses the trusted explicit `windows-fast-bilinear` override. Updating or releasing those packages is not part of this task.

The exact production bundle was copied to a new source-named user-local directory. Its driver, UIA and cursor hashes were rechecked; the previous semantic-actions directory was retained. The ignored config selects the new executable and profile with a live WSL endpoint. The previous config was saved privately. To roll back, select the retained old command/profile with a currently live endpoint; do not use a timing-only diagnostic executable.

After mandatory Pi reload, production `computer_*` calls found one new owned synthetic browser fixture. Full/image/UI observations retained their missing-part contracts. A current image-only 318×500 PNG reported `bilinear` and grounded the first Save pixel click; a fresh UI-only hint grounded the second Save click without inherited pixels. The final native UI and PNG showed `Clicks: 2`. Independent application readback recorded exactly two click and two pointer events, one for each intended Save button. Primary and exact selected-display overviews privately reported Bilinear, 499×333 pixels and no input authority; their images were not forwarded or saved.

Actual `inspect_tui` captured Herdr pane `w3MD:pK`, revision 66, 280×108 cells at the live bottom. The Bilinear/granularity/Clicks: 2 result was readable, with no base64 dump or broken layout. The terminal used its normal image placeholders; this is not a claim that it rendered inline screenshot pixels. Actual owned PNGs were reviewed separately. A read-only Codemode display-discovery parse failed once because that tool returned an object, not a string; correcting the script passed without input replay or runtime changes.

The held fixture finished with exit 0, `sourceGone` and `profileRemoved`; production `computer_close` returned `closed`. No game, Paint or personal-window input was sent. Old runtime files and foreign work were preserved. An optional read-only Windows process-count probe produced no output and was stopped; no OS-wide process-absence claim is made.

## Reproduce the isolated qualification

`node --experimental-transform-types scripts/qualify-native-bilinear.mjs PLAN.json --owned-input --private-displays`

The plan supplies the baseline config path and source, artifact directory and exact driver hash for the production candidate and both diagnostic builds. Artifact directories must be inside ignored `.tmp/fast-bilinear/`. An optional `interop` field supplies a live WSL socket for this experiment without rewriting installed config. The script checks all three binary hashes before staging temporary runtime copies. It does not change the baseline config or installed binary.

The qualifier alternates baseline and candidate calls on one new owned fixture, separates native resize timing from full-call receipt timing, checks three application-witnessed pixel clicks and fresh read-only move/resize detail, and compares authorized primary/selected display reads. Full monitor images stay private and must be removed after review. Display pixels never authorize input. Cleanup closes only the owned fixture and removes its profile and temporary candidate files.

For a separately approved foreground-only display check:

`node --experimental-transform-types scripts/verify-bilinear-display-visibility.mjs PLAN.json --foreground-owned-fixture --private-displays`

This stages only the exact production candidate, creates one owned fixture, foregrounds and positions only that window, and saves its private crops from four sequential display reads. It does not send control input, save complete monitor images, modify config or select a runtime. Actual crop review is separate from its technical success report.

These checks prove this installation's qualified paths, not compositor frame age, universal performance or game reaction speed.
