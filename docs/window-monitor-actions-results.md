# Window actions across monitors: qualification checkpoint

LPT-619 qualifies window input on both connected monitors with CUA source `1f884e28`. The older source `38f50121` passed fresh interactions but failed stale-drag admission after resize. The new native capture binding fixes that regression. Foreground isolation, virtual desktops and concurrent input remain separate work.

## Candidate checkpoint

Fork source `1f884e285d51559a7b8e58f71b15e864f6770be1` implements atomic two-endpoint capture admission and the Windows straight-drag binding. [RFC6](https://github.com/alexshpunt/cua/issues/6) was accepted before implementation; [PR7](https://github.com/alexshpunt/cua/pull/7) stays draft and is not upstream-ready or merged.

[Exact Windows run37623931496](https://github.com/alexshpunt/cua/actions/runs/37623931496) passed 830 core tests, 289 Windows tests (one ignored), and six protocol/schema checks. The unsigned driver reports 0.34.0. All three executable hashes matched the downloaded artifact. Driver SHA256 is `e71483361f7c7348e43a3ee7e65f374df108b66381087c45e7091d9b5bb4218c`. Read-only MCP discovery confirmed 62 tools, capture-bound drag, held paths/keys and the EOF-aware receiver; no input or capture occurred in this check.

On Linux, 843 core tests and 102 platform-windows tests passed. The Linux protocol/schema command could not compile because this host lacks `x11.pc`; it is not claimed as executed. No Linux setup was changed. Generated-contract drift and changed-file formatting checks passed. Adapter regressions went red then green for binding preservation, missing-capture admission and resize refusal without replay. The full adapter snapshot passed 275 unit tests, four related real-Pi integrations, typecheck and diff checks. The scripted MCP test is not native application evidence.

The production checks below ran after reloading the changed extension and config. The user then chose to keep the new runtime. Its exact binaries, licenses and build evidence were copied to a separate permanent versioned folder; all three executable hashes were checked again. The ignored local config selects that folder with interop364. The earlier installed runtimes remain untouched; there is no automatic update.

## Mapping and admission contracts

The common owner test `drag_admission_checks_both_endpoints_before_consuming_one_capture` exercises unequal affine scales, a negative translated component, resize refusal, invalid endpoints that do not consume the capture, and one-use success. Windows `virtualdesk` contracts cover negative left/above origins, different pixel extents and one-pixel round trips. Native source review confirms that capture-bound DragTool skips legacy screenshot scaling and adds the current signed DWM origin once. Adapter regression tests assert unchanged original endpoints and the exact native target/capture ID.

These are deterministic mapping checks, not a live mixed-DPI certification. Both real monitors were at scale1.5. Safe/revocation/lifetime sequence contracts stop before the next capture-bound drag dispatch; the real-Pi regression checks refused resize, consumed observation and fresh recovery through the actual loader/Codemode/MCP boundary.

After selecting the permanent folder and reloading, production `computer_displays` again listed only the two expected monitors: secondary3840×2560 at x2560 and primary2560×1440 at x0, both scale1.5 with DPIunknown. This was metadata-only: no desktop pixels, launch or input. `computer_close` then released the new runtime.

## Candidate live checks (1f884e28)

The same opt-in runner created two new isolated profiles, with independent HTTP event histories. Production discovery returned exact refs for the two owned fixture titles. Initial window geometry matched the baseline. No personal UI, display input or persistent monitor change was used.

- Pixel click `(100,155)` on each 500×500 overview produced exactly one intended click, client `(119,99)`. Native screen points were `(2821,359)` and `(261,359)`, reported background synthetic events.
- Straight drag `(100,266)` to `(350,266)` produced exactly one intended drag per fixture. Native points were `(2821,559)`→`(3270,559)` and `(261,559)`→`(710,559)`. Both app logs reported client x119.33→418.67, y232.33. The native route was synthetic-pen global input with actual delivery unknown; this is not background-isolation evidence.
- Scroll on each observed native element refused background with `background_unavailable`. After a fresh observation and explicit foreground request, native UIA reported actual background delivery. Each independent fixture reached scroll352; its other counters stayed unchanged.
- Grow fixture1 from900×900 to1200×900 without replacing its production overview. Old straight drag refused with `capture_frame_mismatch`; no app event occurred. Reusing that consumed observation then refused locally. Fresh500×375 overview and drag `(150,200)`→`(350,200)` produced exactly one additional drag, client x238.67→558.67,y233. Fixture2 stayed at one drag.
- Wrong-window observation pairing, out-of-image pixels, and input after read-only window detail refused. Detail explicitly reported `input:none`.
- Native fixture setup moved fixture1 to the primary monitor without changing its identity. A fresh pixel click `(75,115)` resolved to current screen `(1281,356)` and changed only fixture1 to two clicks. Membership still remained unknown.

### Manual movement and controlled repeat

During the first run, background drag after movement refused `background_occluded`. A fresh foreground retry returned delivered but the application did not gain a drag. Later overviews showed changed positions for both owned windows. The user confirmed: “я двигал окна”. This concurrent manual movement makes the run inconclusive as a foreground defect or success; we do not infer a native focus bug from it. Fast URL entry also needed observed readback and bounded waits before the private viewer navigation succeeded. No external form was acted on.

The user approved a short repeat without touching the windows. In that controlled run, native setup moved the same900×900 fixture from secondary to primary x1100,y80. Its unchanged pre-movement capture admitted a drag at current screen `(1281,559)`→`(1730,559)` and produced exactly one app drag. Identity stayed unchanged and fixture2 received no input. Then grow to1200×900: the old drag refused `capture_frame_mismatch`, leaving the app at one drag. Fresh500×375 overview admitted `(150,200)`→`(350,200)` at current screen `(1460,560)`→`(1940,560)`, producing exactly one more app drag, client x238.67→558.67,y233. The other fixture still had only its ready event.

The controlled repeat did not need foreground escalation: background dispatch reached the intended application. It proves movement and resize admission, not the separate foreground physical-input matrix. General foreground/focus qualification remains LPT-627; no fix or all-app guarantee is claimed here.

## Candidate human surface and cleanup

Actual `inspect_tui` captured Herdr pane `w3MD:p8`,99×57 cells,revision265. The live progress summary clearly distinguished refusal, successful fresh recovery and the foreground failure; text wrapped without clipping or stray escapes.

The current session's private debug viewer was opened only in one owned isolated fixture browser. Its visible boundary card showed the synthetic500×375 window and the same SHA256 as the explicitly forwarded PNG. Read-only asset fetches independently matched all three retained cards' hashes. Viewer state preserved the native `capture_frame_mismatch` action as an error/refusal. The visible page correctly said final delivery was unconfirmed; it did not claim wire/server observation.

The three-card comparison cache had already evicted older source matches. The visible synthetic card consequently showed `action unmatched`, and no raw comparison was retained; this limitation was left explicit rather than inventing provenance. The current captured source and action trace still showed exact window identity, local coordinate domain and unknown membership. No private URLs, raw transcripts or personal pixels are published here.

Both candidate runs completed `finish`, each with two independent `sourceGone:true` and `profileRemoved:true` receipts. Production discovery found no remaining fixture/debug windows, then `computer_close` released refs/runtime. All task UI is gone. The final controlled run's TUI capture was Herdr `w3MD:p8`,304×108 cells,revision469: refusal/delivered headers, independent cleanup and the completion summary were readable. An unrelated upstream connection error was also visible; it is not a computer-use receipt or a passing tool result.

## Baseline live checks (38f50121)

The approved opt-in runner `scripts/verify-window-monitor-actions.mjs --live-approved` created two isolated Chrome profiles with local synthetic controls. CUA alone launched and positioned them. Production `computer_*` calls discovered actual window refs and used fresh window images for measured input. No personal UI or display input was used.

Both window overviews were 500×500 with native window bounds 900×900. One fixture was on secondary DISPLAY1 at host x2640,y80; the other was on primary DISPLAY2 at x80,y80. Both monitors had native scale 1.5; DPI and production window membership remained unknown.

| Interaction | Actual native result | Independent application readback |
| --- | --- | --- |
| Pixel click `(100,155)` in each window | Background synthetic events; native screen points `(2821,359)` and `(261,359)` | Exactly one click in each intended fixture; both reported client `(119,99)` |
| Straight drag `(100,266)` to `(350,266)` in each window | Synthetic-pen global input; actual delivery unknown, not a promise of background isolation | Exactly one drag in each intended fixture, with matching client start/end coordinates |
| Observed-element scroll in each window | Background refused with `background_unavailable`; after fresh observation and explicit foreground request, native UIA reported actual background delivery | Scroll changed to 352 and 528 respectively; the other fixture's event history stayed unchanged |
| Pair one window ref with the other window's observation | Adapter refused stale/missing pairing | No input event |

Native receipts and application events were checked separately. A delivered receipt alone was not counted as a changed application. No claim about focus isolation is made for synthetic-pen global input; that belongs to the separate background/input qualification.

## Failing stale-geometry check

A new isolated fixture reproduced the mismatch without touching any other app:

1. Observe its 900×900 window, returning a 500×500 image.
2. Grow the owned window to 1200×900 through native fixture setup. Only metadata discovery follows, so the production overview stays old.
3. A pixel click from the old overview refuses with `capture_frame_mismatch`; no fixture event occurs.
4. Restore 900×900, obtain a fresh production overview, then grow to 1200×900 again.
5. The old drag `(100,266)` to `(350,266)` is dispatched as delivered via synthetic pen at the old screen points `(2820,558)` to `(3269,558)`. The centered drag surface has moved. Its independent event log and UI remain at zero drags.
6. Obtain a new 500×375 overview. A newly grounded drag `(150,200)` to `(350,200)` reaches the surface, emits one event and changes the UI to one drag.

This was a failed acceptance check, not an unsupported-app excuse. Existing capture-bound click admission checked live dimensions/owner, while this older straight-drag route used the last screenshot context without that binding. The user then approved the focused native fix. The original failure remains the baseline; it is not evidence that the new candidate passed.

## Baseline human surface and cleanup

Actual `inspect_tui` captured Herdr pane `w3MD:p7`, 71×57 cells, revision 344. The progress/refusal summary and cleanup receipt were readable and wrapped cleanly. This is a checkpoint, not final corrected-feature verification. The private debug surface, final regression suite and safe/revocation cases still need the finished revision.

The first resize probe used an invalid `observation_only` argument in its harness. It stopped and cleaned both windows/profiles; no native behavior claim relies on that failed call. The harness now uses metadata-only `list_windows` for resize readback.

Both completed runs have cleanup receipts confirming source removal and isolated-profile removal. Production discovery found no remaining fixture windows, then `computer_close` released this session's runtime. Private images, hardware paths and raw transcripts stay in ignored task storage. Syntax and diff checks passed; no new full unit/integration test result was claimed for that baseline checkpoint.
