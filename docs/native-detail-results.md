# Native window and display detail — LPT-407

## Result

Verified on Windows/WSL with the unmodified official CUA Driver **0.33.2**. Window, display and browser now share this qualified pin. Older local installs were kept. No automatic update, PATH/service change or driver patch was used.

`computer_observe` accepts a detail rectangle in the latest returned overview PNG and its `agent_image.image_id`:

- **Window:** fresh native padded JPEG through CUA `zoom`. No window raising or display fallback.
- **Primary display:** YOLO-only fresh full-resolution CUA capture, then focused Sharp extraction and optional Lanczos3 downsampling. Not an enlarged overview or saved-original crop.

Details are read-only. They consume their overview context; window detail also disarms its earlier input observation. Another detail or window action needs a new overview. Safe, cancellation, missing/stale context, invalid geometry and window lifetime checks refuse or withhold pixels. Raw intermediate display pixels are never forwarded.

Usage and limits: [native-detail.md](native-detail.md). Redacted measurements: [evidence/native-detail/run.json](evidence/native-detail/run.json).

## Checks

| Check | Observed result |
| --- | --- |
| Official release qualification before pin update | 72 native calls covering display, disposable Calculator, browser input/zoom, stale hints, close/reopen storage and cleanup |
| Release integrity | ZIP SHA-256 `82fd647e6f4b69ed811e52e9586a4e56291e477ad699fb02441193a45364337c`; all five executable/library Authenticode signatures Valid, Cua AI, Inc. |
| Regression and real-Pi contracts | 76 unit tests, TypeScript check and 7 real-Pi cases passed |
| Native detail fixture | 13 calls, 5 actual images inspected; Calculator JPEG and synthetic owned-browser display region readable |
| Forbidden dispatch | Old overview input and nested detail dispatched zero calls; real-Pi cases forwarded only final detail PNG/JPEG |
| Main Pi display | 499×333 overview of a 3840×2560 primary display; selected 240×140 overview region mapped outward to 1847×1077 native pixels, returned as 1200×700 PNG |
| Main Pi window | 331×499 Calculator overview; selected region returned as native 500×246 JPEG with enlarged controls |
| Vision debug | Exact returned image hashes and source/region/settings matched private exports at revisions 35 and 53 |
| Human TUI and corrected UI | Actual viewport inspected at revision 1823 after reload. Metadata readable; stock collapsed image rows hide inline pixels. Corrected native/adapter route labels and 500/1 controls verified live |
| Cleanup | Owned Calculator HWND and both viewer browser processes disappeared. Final read-only check: Driver count 0, profiles 0 |

The static viewer-label fix also passed focused tests, TypeScript and all 7 real-Pi cases before its final reload. The selected clean index snapshot independently passed all 76 unit tests, TypeScript and 7 real-Pi cases before committing; no untracked research or private artifacts were included.

Meaningful red tests caught the missing detail API, stale display context after backend failure and overview raster/metadata mismatch before fixes. Initial harness failures assumed structured `computer_open` output and automatic Codemode exceptions for observation refusal; the harness was corrected to the existing contracts. No input was replayed to recover a failed check.

One Calculator close briefly left an unavailable closing window in discovery. A later read-only handle check proved disappearance; no second close click was sent.

## Limits and privacy

- Fresh capture is not a fresh-paint or atomic-desktop guarantee.
- Native window JPEG width is capped at 500; padding and mapping are CUA's. Its reported crop origin is unavailable and remains null.
- Display detail defaults to 1200px long edge, scale 1, without enlargement. Per-request sizing does not change overview settings. Native overview rounding may return 499px for a 500px cap.
- Display detail grants no input and is forbidden in Safe. Safe remains a UI policy, not an OS sandbox.
- Private display/window pixels, wider window text, viewer URLs and native identities were not published. Durable evidence contains only geometry, settings, hashes, counts and cleanup results. The export verifies private asset hashes before writing that whitelist.
- Browser zoom/input behavior, IDE, cache, Sandbox and broader model-coordinate benchmarks were not changed.
