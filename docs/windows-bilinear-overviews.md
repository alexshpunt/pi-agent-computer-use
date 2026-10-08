# Windows Bilinear overviews

[LPT-663](https://linear.app/alexshpunt/issue/LPT-663) replaces only the resize filter for capped Windows window, primary-display and selected-display overviews. PNG encoding, capture and input do not change. This isolated candidate is not merged or selected by the normal installation yet. The user requires a final review before merge.

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

The overview metadata/viewer regression first failed against the old hardcoded filter. All 341 extension unit tests, typecheck and 24 real-Pi integration tests passed. They cover captured settings, old profiles, wrong-artifact rejection and the fixed viewer selector. Live Windows image, timing, coordinate, display and TUI qualification is still pending.

## Reproduce the isolated qualification

`node --experimental-transform-types scripts/qualify-native-bilinear.mjs PLAN.json --owned-input --private-displays`

The plan supplies the baseline config path and source, artifact directory and exact driver hash for the production candidate and both diagnostic builds. Artifact directories must be inside ignored `.tmp/fast-bilinear/`. The script checks all three binary hashes before staging temporary runtime copies. It does not change the baseline config or installed binary.

The qualifier alternates baseline and candidate calls on one new owned fixture, separates native resize timing from full-call receipt timing, checks three application-witnessed pixel clicks and fresh read-only move/resize detail, and compares authorized primary/selected display reads. Full monitor images stay private and must be removed after review. Display pixels never authorize input. Cleanup closes only the owned fixture and removes its profile and temporary candidate files.

A completed test run does not prove compositor frame age, universal performance or game reaction speed. Actual readability and production/TUI checks must be reported separately before calling adoption complete.
