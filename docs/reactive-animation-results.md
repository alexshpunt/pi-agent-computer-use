# Reactive animation results

LPT-644 uses existing CUA cursor controls only. `computer_act({animation:"reactive", ...})` applies the trusted local glide for one native call and restores the previous glide. Default reactive glide is 1ms; CUA's ordinary automatic value was 0 in this run. Native click waits remain unchanged. See [usage](reactive-animation.md) and [redacted evidence](evidence/reactive-animation/run.json).

## What ran

After extension reload, production Codemode clicked two alternating Save buttons in a new isolated local Chromium fixture. Each action had a fresh native overview and current short hint. Ten counter changes and ten pointer events confirmed the exact alternating targets. Six calls opted in; ordinary calls ran before and after them.

| Measurement | Samples | Result |
| --- | ---: | --- |
| Ordinary first placement | 1 | 131ms; excluded from moving-click comparison |
| Ordinary moving action, before/after reactive scope | 3 | 510/520/522ms; median520ms |
| Reactive action, including switching and restoration | 6 | 159–183ms; median166.5ms |
| Reactive native call | 6 | about98–102ms; median about100ms |
| Reactive profile apply | 6 | about17–25ms |
| Reactive profile restore | 6 | about19–28ms |

Every reactive receipt read back the requested glide and confirmed restoration of the exact prior value0. The final ordinary calls took520/510ms, consistent with the earlier522ms ordinary moving call. This small sample shows an improvement here, not a promise that a click takes1ms or that every app behaves the same.

## Defects found and corrected

The first fixture launch used an old root-path assumption that treated a nested runtime executable as a directory. Its startup call timed out after an owned window appeared. The agent discovered and closed that exact fixture without blindly relaunching. The fixture now uses the executable's parent for its disposable profile; no runtime or machine setup changed.

The first valid live trial delivered six physical clicks. Its sixth action returned unknown because six immediate native state reads finished before queued restoration reached the cursor render thread. The program stopped without replay; actual events confirmed that the click had happened. A focused render-turn test reproduced this race before the fix. On a mismatch, the state check now yields5ms before its next read, with at most six reads and five yields. This only waits for state application; the native35ms press/release and50ms post-click pauses remain unchanged.

The final live run completed10/10 verified actions with no restoration uncertainty. All three valid fixture sources and disposable profiles were removed; production `computer_close` released its runtime/helper without closing user windows. No input was sent to the game, Paint or unrelated user windows. The driver pin and permissions were not changed. Profile isolation was not established for the initial timed-out startup; its only input was closing the authorized fixture window. The three valid fixtures used disposable profiles with verified removal.

## Contracts and human view

Behavioral tests cover ordinary calls with no cursor-control overhead, exact apply/restore, native refusal and cancellation without replay, unapplied motion with no input, restoration failure blocking later calls, serialized concurrent calls, close-generation rejection, fresh calls after close, delayed render application and invalid local configuration.

A deterministic real-Pi integration loads the production tool schema/session through Codemode, uses configured2ms for an explicit action, rejects a consumed observation, then verifies normal240ms input before and after close. It is loader/routing evidence, not physical Windows input.

The actual Herdr viewport was inspected at pane `w3ME:p2`, revision706,304×108cells. Its four-line summary showed the verified count, exact restore, latency comparison and unchanged native pauses clearly. Default JSON receipts can collapse; the screenshot did not show an inline window image. No inline-image claim is made.

The final review also reproduced a close-mid-profile reconnect race in a behavioral test. Native state/control/input calls now check the closed state before dispatch. After the final reload, a fresh two-click smoke confirmed one reactive scope and the following ordinary call: both application events passed, previous glide0 was restored, and call times were200/521ms. Its readable three-line summary was inspected in the same Herdr pane at revision719. This smoke verifies the loaded final code; the comparison table above is the separate ten-click trial.

## Final verification

The selected clean tree `37ef93ac5dc80ff6c37f032817490fada0296cfc` passed 286 unit tests in 30 files, typecheck, 19 real-Pi tests in 17 files, fixture syntax and Git diff checks. It includes the final close guards and scoped animation behavior. Later changes only add this evidence; executable files are unchanged.

## Limits

Times are adapter/tool wall-clock measurements, not physical-event or compositor timestamps. Native delivery is not application success; the fixture's counter and read-only event witness supplied that separate check. No new native cancellation matrix, other platform, game attempt, runtime installation or click-pause optimization was included.
