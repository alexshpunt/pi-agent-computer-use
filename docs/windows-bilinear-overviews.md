# Windows Bilinear overviews

[LPT-663](https://linear.app/alexshpunt/issue/LPT-663) replaces only the resize filter for capped Windows window, primary-display and selected-display overviews. PNG encoding, capture and input do not change. This candidate passed isolated Windows qualification, but is not merged or selected by the normal installation yet. The user requires a final review before merge.

## Native change

The CUA candidate is `4825375a7d7827cd5dcf0f34924aa45611533853`, based on semantic-actions source `ab86b25cba1cb9c6f5025f25fdd7a8cb3cd21a44`. [Draft PR 15](https://github.com/alexshpunt/cua/pull/15) contains the native change.

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

The overview metadata/viewer regression first failed against the old hardcoded filter. All 341 extension unit tests, typecheck and 24 real-Pi integration tests passed. They cover captured settings, old profiles, wrong-artifact rejection and the fixed viewer selector. The isolated Windows qualifier passed 116 window samples, 24 display samples, three application-witnessed clicks, five read-only details and Safe display denial. Production tools and their TUI still need verification after approved merge and reload.

## Live results

The same new synthetic window used a 1600×1200 host rectangle and a 500px image cap. Ten warm samples per runtime/mode alternated baseline and candidate; two diagnostic builds separately measured native resize including destination allocation, excluding capture and PNG.

| Measurement | Lanczos3 | Bilinear |
| --- | ---: | ---: |
| Native resize median | 50.30 ms | 4.00 ms |
| Image-only capped call mean | 125.48 ms | 86.47 ms |
| Full capped call mean | 155.68 ms | 133.05 ms |
| Native-size call mean | 93.63 ms | 92.27 ms |
| UI-only call mean | 89.11 ms | 81.36 ms |

Resize was about 12.6× faster in this run. Native-size and UI-only calls do not resize, so their differences are timing variation, not evidence of a resize benefit. Full-call times are SDK receipt times, not compositor frame age or a game latency guarantee.

All 24 capped window traces kept one final PNG encode and no intermediate PNG encode/decode. File delivery without an embedded image or UI tree also passed. The actual 500px window PNG had readable title, canvas text, Save buttons and item labels. Three clicks before/after movement and resize had independent click/pointer witnesses; the largest coordinate error was 0.77 CSS pixels per axis.

Primary and selected-display paths returned matching capped/native dimensions. Only one physical 2560×1440 monitor was connected, so selected addressing used that same primary monitor. This is not a multi-monitor claim. Private crops showed recognizable UI/code panes, but tiny text was not fully legible at a 500px monitor cap. The fixture was occluded in those display crops; they do not prove fixture readability. Use fresh read-only detail for small text. No whole-monitor image is published; private monitor files and crops were removed.

The owned fixture/profile, clients, site and temporary candidate copies all cleaned up. Baseline config bytes and the installed baseline executable hash were unchanged. The original WSL endpoint had disappeared, so the experiment used a live endpoint override without writing config. [Redacted samples and checks](evidence/windows-bilinear/run.json) retain timing and geometry evidence without screenshots, native IDs or window titles.

## Reproduce the isolated qualification

`node --experimental-transform-types scripts/qualify-native-bilinear.mjs PLAN.json --owned-input --private-displays`

The plan supplies the baseline config path and source, artifact directory and exact driver hash for the production candidate and both diagnostic builds. Artifact directories must be inside ignored `.tmp/fast-bilinear/`. An optional `interop` field supplies a live WSL socket for this experiment without rewriting installed config. The script checks all three binary hashes before staging temporary runtime copies. It does not change the baseline config or installed binary.

The qualifier alternates baseline and candidate calls on one new owned fixture, separates native resize timing from full-call receipt timing, checks three application-witnessed pixel clicks and fresh read-only move/resize detail, and compares authorized primary/selected display reads. Full monitor images stay private and must be removed after review. Display pixels never authorize input. Cleanup closes only the owned fixture and removes its profile and temporary candidate files.

A completed test run does not prove compositor frame age, universal performance or game reaction speed. Actual readability and production/TUI checks must be reported separately before calling adoption complete.
