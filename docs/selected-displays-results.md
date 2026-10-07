# Selected-display verification

LPT-618 was checked on Windows from WSL on 2026-10-07. This qualifies the explicit `windows-selected-displays` profile, not other platforms or arbitrary driver versions.

## Exact native artifact

- Source: `38f50121c9cc15938a18330f4c3334a27f898e83`, CUA Driver 0.34.0.
- [Windows build 37602770786](https://github.com/alexshpunt/cua/actions/runs/37602770786): 829 core tests, 287 Windows tests (one ignored), two protocol and four schema checks, release build and bundle passed.
- Driver SHA-256: `1dbd499cfd43b98f31dc3fb51c7a001dc72bd116db235c304c0486b32df8a24d`.
- Exact artifact discovery verified all bundle hashes, version, 62 native tools, EOF-aware envelope support and inherited drag/key-hold capabilities. The executables are unsigned.
- The unchanged qualified base also [built on Windows](https://github.com/alexshpunt/cua/actions/runs/37595775262) before native work.

The owner separately approved temporary qualification and then keeping the checked driver. It was copied into a new `cua-driver-0.34.0-displays-38f50121` folder and selected in the ignored local config. Previous installed drivers were not overwritten. Hash/schema checks and the native two-monitor fixture passed again from the permanent folder.

## Two connected monitors

Native enumeration matched a separate Windows OS report, including work areas and scale:

| Native logical ID | Primary | Physical host bounds | Work area | Native scale | DPI |
| --- | --- | --- | --- | --- | --- |
| `\\.\DISPLAY1` | No | x2560, y0, 3840×2560 | x2560, y0, 3840×2488 | 1.5 | Unknown |
| `\\.\DISPLAY2` | Yes | x0, y0, 2560×1440 | x0, y0, 2560×1368 | 1.5 | Unknown |

HMONITOR and native device paths were returned, but private hardware paths are not copied into public evidence. IDs describe logical monitors in the returned topology, not permanent hardware serials. Live monitors did not have negative origins or different scale factors; those cases were checked with deterministic native/adapter contracts. No monitor arrangement, scale or connection was changed.

The opt-in `scripts/verify-selected-displays.mjs` opened two isolated Chrome profiles through CUA. A blue fixture was placed on DISPLAY1 and a green fixture on DISPLAY2 using existing native fixture setup. Both full-resolution selected captures matched independent native window samples exactly: blue `[37,73,245]`, green `[96,201,115]`. CSS RGB values were not used as an exact oracle because native pixels differed from them. A missing display and wrong topology refused without images. The older primary capture still returned its primary-scoped result.

## Production tools after reload

`computer_displays` returned two distinct opaque refs and explicit monitor membership. Window observations kept monitor membership unknown. `computer_observe({display:ref})` returned selected-monitor overviews with local `(0,0)` origins, full native dimensions and separate host bounds. Full desktop intermediates were not explicitly forwarded.

Fresh fixture crops from both sources were explicitly forwarded and showed the correct labels and colors:

| Selected monitor | Overview | Overview rectangle | Native-local crop / output |
| --- | --- | --- | --- |
| DISPLAY1 | 499×333 | 13,32, 111×65 | 100,246, 855×500 |
| DISPLAY2 | 500×281 | 20,47, 167×97 | 102,240, 856×498 |

Both returned `selected_display_region`, `detail_image_pixels`, unknown DPI and `input:none`. Consumed overview IDs and an ID from the other monitor refused without images. The cross-source check also ran with two valid overviews. A display ref/image ID could not authorize window input.

Ordinary window capture worked through the same tools. Chrome background hotkey/scroll attempts returned explicit native refusals. After fresh observations and explicit foreground requests, navigation and scrolling completed and readback confirmed the owned debug page. Native receipts, including actual delivery, remained separate from the requested mode.

A later display crop showed an occluding window instead of the background fixture. That is expected: selected display capture reads the visible monitor, not an isolated window layer. Use window capture for a background window. No fallback or incorrect monitor selection was observed.

## Human and payload surfaces

The private debug viewer was opened only in an owned fixture browser. It showed exact selected-crop hashes, dimensions, native monitor membership, `selected_display_region` and the capture timestamp. One checked crop was 855×500, 59,746 bytes, SHA-256 `6836ac62c0b52efd9c511baa3cf7c4ae358d85815bf3e5c8075ff858dbcafc42`. This is Pi's application-boundary evidence; final wire delivery remains unconfirmed.

The viewer retains only three ordinary capture associations. Later observations can evict an earlier crop's association and label its still-forwarded bytes unmatched. Source/hash checks were made while the crop was retained; this does not imply longer retention.

`inspect_tui` captured the actual Herdr pane `w3MD:p6`, 161×57 cells, revisions 286 and 293. Summary rows, refusal results and the application-boundary warning were readable, with no broken borders or escape codes. This terminal showed image placeholders; the actual images and source fields were checked in the private viewer and native window PNGs, not inferred from the placeholders.

After selecting the permanent folder, a second reload and production discovery smoke listed both monitors again without forwarding desktop pixels. A final `inspect_tui` capture showed the readable monitor summaries in pane `w3MD:p7`, 73×57 cells, revision 133; lines wrapped cleanly at the narrower width. The runtime was closed afterward.

## Regression checks and limits

- 267 unit tests passed, including selected-monitor identity, fresh crops, negative origins, per-source resources, changed topology, revocation, cancellation, no input and old-profile refusal.
- Six related real-Pi integration checks passed: selected displays in YOLO/Safe, primary display, native detail and the unified tool registry.
- Typecheck, script syntax and diff checks passed.
- Duplicate running Chrome rows with the same executable were reproduced red/green in two focused helper tests. Different executable paths still refuse before launch.

There was no live unplug/scale change or forced access-policy change. Those refusal cases were checked by contracts. No selected-display input, window relocation feature, selected-monitor temporal capture, virtual-desktop management or concurrent-agent arbitration is included. The optional human-only Qt overlay still supports primary/windows only; selected reads clear its mark and report the limitation. Paint freshness remains unverified.

All fixture windows and unique profiles from the production run were removed, and its native runtime was released. Raw desktop pixels, viewer URLs and transcripts remain private temporary data, not public evidence.
Finish the live runner before changing workspace. A later permanent-folder runner was interrupted before its automatic cleanup; its two windows were rediscovered and closed through current native Close targets, then only its isolated profiles were removed. No automatic cleanup receipt is claimed for that interrupted run.