# Single-PNG Windows overviews

LPT-654 removes the full-size PNG round trip before downscaling a Windows window overview. Capture still uses the same guarded PrintWindow/WGC/fallback path. The overview converts captured BGRA pixels, resizes them with the existing Lanczos3 policy, and encodes one final PNG.

The native owner receives the original frame dimensions directly. Its final PNG, delivery modes, coordinate mapping and capture publication stay unchanged. Existing recording, detail, display and mapped-click paths keep their previous processing. This is not a new capture backend or a raw-image tool API.

## Exact sources

- Previous runtime: `506239da08cfdafa63dac1857f5471752fb70f5e`, driver SHA256 `0e25c8b83fd48b54be479eb128452a6f6b099b5ff6ce2d20bac024eda07ead16`.
- Production candidate: `c2d84f0947b6ec0170cb8bd3114fe62e42e5bdd9`, driver SHA256 `f63720485d48bfcc2637f1b65dc875241b10ad1fdd6e30847fdfde9f39a2b505`, [Windows build 37742505404](https://github.com/alexshpunt/cua/actions/runs/37742505404).
- Timing-only child: `099838bf0f04e5487d234bd7b77d8e361f29f618`, [Windows build 37742690665](https://github.com/alexshpunt/cua/actions/runs/37742690665). It is never selected as the production runtime.

Both Windows builds passed 65 contract, 834 core and 289 platform tests, with one existing ignored platform test, plus six protocol/schema tests. All three executable hashes matched each artifact. These are unsigned builds; no new UIAccess signing claim is made.

The new explicit `windows-single-png` profile retains the earlier input/capture capabilities and checks its exact hash before startup. `windows-shell-desktops` and the previous installed folder remain available. Defaults and permissions are unchanged.

## Pixel and live qualification

The pure-image regression suite passed all 14 tests. Thirty cases compared old and new decoded RGBA pixels and dimensions exactly, including portrait/landscape/square images, narrow aspect ratios, alpha, channel order and caps. Native-size and within-cap outputs also matched the old encoded bytes. Wrong buffer lengths rejected.

A separately staged candidate and diagnostic client read only a newly owned local browser fixture. The run made 80 paired warm calls, 12 setup calls and 12 warm traced calls. The 500px outputs were 500×376; native-size outputs were 1580×1189. Image-only, full, UI-only and forced file delivery passed.

Each of ten capped native traces had one final PNG encode and one Lanczos3 resize, with no intermediate full-size PNG encode or pre-resize PNG decode. Final capture validation remains; this does not claim zero PNG decoding everywhere.

Three returned-image pixel clicks reached the fixture at baseline, moved and resized geometry. The largest error was 0.771 CSS pixels per axis at browser DPR1.5; this is not an OS-DPI claim. Three fresh native JPEG details after move/resize preserved the original requested overview rectangle and stayed read-only. Actual overview pixels were reviewed. All owned windows, profiles, clients, sites and staged diagnostic files were cleaned; production config stayed unchanged during qualification.

## Paired warm timing

Arithmetic mean per SDK call, ten samples per runtime/mode, alternating order:

| Mode | Previous | Candidate |
| --- | ---: | ---: |
| Image-only, 500px | 121.3ms | 108.2ms |
| Full, 500px | 157.0ms | 143.2ms |
| Native-size image | 90.5ms | 85.8ms |
| UI-only | 81.9ms | 84.9ms |

The capped paths saved about 13–14ms in this fixture run. UI-only did not improve, as expected for a pixel-processing change. These are call-receipt timings, not compositor frame age, universal latency or game reaction results. Capture, resizing, process metadata and transport still take time. Do not compare absolute stage timings with the differently sized fixture in the earlier profile.

See [redacted evidence](evidence/single-png/run.json). Private pixels, paths, source handles and fixture URLs are not published.

## Reproduce

`node scripts/prepare-native-single-png.mjs /root/dev/cua` generates the narrow patch from immutable source `506239da` without editing the active CUA checkout. `--tests-only` generates the failing regression source. It uses the existing pinned rustfmt 1.97.1, not an installer.

For timing instrumentation, `scripts/prepare-native-observe-trace.mjs` accepts an exact source SHA and optional ignored output directory after the repository argument. Its old defaults are unchanged. Build the production and timing-only sources separately with the existing Windows fork workflow; verify the artifact source SHA and all executable hashes.

`WSL_INTEROP=<live socket> node --experimental-transform-types scripts/qualify-native-single-png.mjs <private plan.json> --owned-input` checks exact candidate artifacts, paired observations, encode spans, pixel hits, movement/resize detail and owned cleanup. The private plan supplies the two downloaded artifact directories, exact source/hashes/build runs and pinned base. It does not select or install a runtime.

## Delivery checkpoint

Native qualification passed and the production candidate was copied to a separate `cua-driver-0.34.0-single-png-c2d84f09` installation. Source and all executable hashes were checked again; MCP discovery reported the expected 0.34.0 peer and existing path/key/capture-bound-drag features. The ignored local config selects the explicit new profile; the previous folder and pin are retained.

After the approved Pi reload, production `computer_*` tools used the new exact runtime on one newly owned fixture. Full planning returned pixels and UI; image-only returned fresh pixels without inherited UI and delivered a pixel Save click; UI-only returned current hints without pixels and delivered the second Save click. The application counter and independent event journal confirmed both clicks and both pointer events. The fixture/profile and owned runtime were closed; user windows stayed untouched.

The actual human viewport (Herdr pane `w3ME:p2`, revision 3216, 188×57 cells) showed the successful tool rows and one complete readable bounded summary. No clipped summary, stray escape codes or payload dump was observed. This is a smoke check, not a canonical platform matrix.

Current verification passed 310 unit tests, typecheck, 23 real-Pi tests and diff checking. Final selective delivery is recorded in the linked Linear Task.
