# Semantic action qualification

The owner returned LPT-626's no-focus goal and LPT-630's independent concurrent-agent goal to Ideas. The new strict UIA functionality is retained as an experiment with a known focus limitation. This is a failed full qualification, not a general background-action guarantee.

## First candidate: 8ac536b6

Exact source `8ac536b6ee22e89d40c43fcc1c1cd2cfae11c9c1` passed Windows build [37755779213](https://github.com/alexshpunt/cua/actions/runs/37755779213): 68 contract, 836 core and 295 Windows-platform tests (one ignored), plus six protocol/schema checks. The unsigned driver SHA256 was `04b6a2ab9028cbd431d916aad646da0de46b9df4cb2ddd7c71c0aff6177f809c`. All three executable hashes, licenses, version, envelope support and native schemas were checked before temporary use. The older installed runtime was preserved.

The production extension was reloaded after 336 unit tests, four related real-Pi integrations and typecheck passed. Tests cover exact strict requests, unsupported/disabled/stale targets, qualification, lifetime, Safe revocation, cancellation and uncertain provider receipts. They do not replace native application checks.

| App and desktop | Invoke | Select | Set value | Qualification |
| --- | --- | --- | --- | --- |
| Isolated Chrome, current desktop | Counter changed | List option changed | Field changed | App readback and controlled sentinel checks passed |
| Disposable Notepad, current desktop | New tab appeared | Existing tab became selected | Editor text changed | Fresh UIA readback and controlled sentinel checks passed |
| Isolated Chrome, other desktop | Counter changed | Option changed | Field changed | **Failed:** target moved to current desktop after the first call |
| Disposable Notepad, inactive desktop | Required content control absent | Tabs absent | Editor absent | No content action dispatched; not a successful supported pair |

Chrome had 576 valid foreground/focus samples over 18.012 seconds on the current desktop. Notepad had 364 over 11.362 seconds. All samples in those controlled intervals identified the separate sentinel, whose field stayed `Sentinel only` and whose DOM active field stayed `sentinel`. Two other intervals did not start with the sentinel foreground and were excluded.

The nominal other-desktop run had 1,030 unchanged sentinel samples over 32.221 seconds, but focus alone was insufficient: the target's desktop changed. A controlled single-Invoke repeat confirmed the defect with the same window reference. At `1791453216836`, its GUID belonged to another desktop and `on_current_desktop` was false. At `1791453217233`, after the call, it belonged to the sentinel desktop and the flag was true. The counter changed from 3 to 4. All 634 samples over 19.792 seconds stayed on the sentinel. The owner explicitly left the windows untouched during this repeat.

Strict selection on a Chrome text input refused with `semantic_pattern_unsupported`, `attempted:false` and `fallback:false`. Reusing that consumed observation refused locally before another native call. Browser DOM click/input events are app reactions to UIA; they are not evidence that native mouse or keyboard input was dispatched.

[Sanitized measurement summary](evidence/semantic-actions/8ac536b6.json) preserves the failed qualification, bounded focus measurements and cleanup result. Private full sample rows were kept separately during execution. The sampling goal was 20 ms, not guaranteed: maximum observed gaps were 47–48 ms. The probe was bounded to 120 seconds/6,000 rows; fixture event storage was bounded to 1,000 events and did not reach that cap. These samples cannot prove every intermediate transition or future provider behavior.

## Corrected candidate: ab86b25c

The strict route used the existing pointer `NoActivateGuard`, which changes `WS_EX_NOACTIVATE`. Its removal/restoration coincided with invalid shell membership and reassignment to the current desktop. The follow-up source `ab86b25cba1cb9c6f5025f25fdd7a8cb3cd21a44` removes that guard from strict UIA only and retains the existing EnableWindow provider focus shield. Ordinary physical actions are unchanged.

Five focused native dispatch tests and format/diff checks passed. Exact Windows build [37760419286](https://github.com/alexshpunt/cua/actions/runs/37760419286) then passed 68 contract, 836 core and 295 Windows-platform tests (one ignored), plus six protocol/schema checks. The unsigned driver SHA256 is `17cf450b3e202b9f4b4153133dfb8f4bc3d8121c5f2d0246a6c3ec78e3f49185`. All three executable hashes, licenses and the native strict API were checked. The owner first approved temporary qualification, then separately chose permanent retention with the explicit focus limitation after the failed live check.

The corrected candidate changed all six intended current-desktop controls: Chrome Invoke counter 0→1, selected option before→after and value before→`Chrome ab86 current`; Notepad Value→`Notepad ab86 current`, Invoke opened a new blank tab, and SelectionItem selected the original modified tab. Fresh UIA readbacks agreed. Production discovery before and after each action kept the same window reference, desktop GUID and current-desktop flag.

**Foreground/focus qualification failed.** The interval contained 1,875 valid samples over 58.870 seconds, with a maximum gap of 47 ms. Only the first 561 rows identified the sentinel for both foreground and focus. The first Invoke ran at `1791456230562`–`1791456230677`; samples left the sentinel at `1791456230581`, and identified the Chrome target as foreground at `1791456230611`. Independent browser events recorded sentinel blur and target focus. Later Notepad actions also changed foreground/focus. The owner confirmed no interaction with the windows during this measurement. Sentinel text stayed unchanged, but that does not pass the focus criterion.

The corrected other-desktop repeat was not run after this failure. No successful no-focus or independent multi-agent result is claimed. [Sanitized corrected-run evidence](evidence/semantic-actions/ab86b25c.json) keeps the six action readbacks, timestamped focus transitions and cleanup receipts. UIA completion still reports focus/app effect as unverified, with no physical fallback. The root cause of activation is not established.

## UI and cleanup

Actual Herdr viewport `w3MD:pF`, 71×57 cells, revision 249, showed a readable concise summary and tool status. Raw JSON wrapped heavily in the narrow pane; later results used short action/readback lines. After the final reload, actual Herdr viewport `w3MD:pG`, 188×57 cells, revision 425, showed the completed metadata/close tools and readable two-line summary. The longer tool result was collapsed, not displayed as a raw dump.

For the first candidate, both isolated Chrome windows and their unique profiles were removed with verified cleanup receipts. The owner returned only the disposable Notepad for cleanup. Its test text was cleared; three unmodified task tabs were closed through current UIA controls. Production discovery then found no task Chrome or Notepad windows, and the computer runtime was closed. The ignored config was restored to the older permanent single-PNG runtime. No personal windows, profiles or desktop lifecycle were changed.

For the corrected candidate, the runner ended successfully after one `finish` command and reported both Chrome windows gone and both unique profiles removed. Task Chrome and all Notepad discovery were already empty before this cleanup; the task Notepad reference was closed. We did not send another Notepad close action or establish who closed it. No Notepad profile/tab-state cleanup is claimed. The computer runtime was released. No personal windows were targeted.

## Retained runtime and deferred research

The owner explicitly chose to keep the useful UIA operations despite the focus limit. Exact ab86b25c binaries, licenses and Windows build evidence were copied to the separate permanent `PiComputerUsePoC/cua-driver-0.34.0-semantic-actions-ab86b25c` directory. All three executable hashes and the advertised native API passed the checker again there; it made no input or capture call. The ignored local config selects this runtime. Older installed versions remain unchanged. Retention is not full LPT-626 acceptance.

A fresh production reload using the permanent path passed metadata discovery and runtime close without opening windows or reading desktop pixels. At this final checkpoint Windows reported only one connected monitor: `DISPLAY2`, primary, bounds `(0,0,2560,1440)`, scale 1.5, DPI unknown. This is the current topology, not a repeat of the earlier two-monitor qualification. The loaded `computer_act` description explicitly warns that native UIA may take foreground/focus. Final automated checks passed: 336 unit tests, four related real-Pi integrations and typecheck.

We have no implemented and qualified solution for independent simultaneous control in our current stack. Windows architecture is not proven incapable. Future options include documented [UIA AutoSetFocus](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-put_autosetfocus), which defaults to automatic focus for many actions; [one connected child session](https://learn.microsoft.com/en-us/windows/win32/termserv/child-sessions), already used by [Power Automate Picture-in-Picture](https://learn.microsoft.com/en-us/power-automate/desktop-flows/run-desktop-flows-pip); [Windows Server RDS](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/overview), [licensed Enterprise multi-session](https://learn.microsoft.com/en-us/azure/virtual-desktop/windows-multisession-faq), or separate Windows VMs. These are source-backed research directions, not local passes or adopted providers. No further native repair, Windows feature, session or guest setup was performed.

## Desktop-aware guard: e6d26cb6 (LPT-626, M9)

The two earlier candidates failed in opposite ways: with the pointer guard the sentinel kept focus but an other-desktop target moved to the current desktop; without it the target took the foreground. Source `e6d26cb6d20ae7abd2cdcb58e847eb5edffc2c38` arms the WS_EX_NOACTIVATE guard only for a target already on the current desktop and keeps only the provider focus shield otherwise. Build [39500808704](<https://github.com/alexshpunt/cua/actions/runs/39500808704>) passed; driver SHA256 `59c7f48e3c86ed330eab20d9dce23a45c83479a062003aa7305875206e30644d` matches the build's hashes.json.

`test/live/semantic-focus.live.ts` runs in a disposable Windows Sandbox on ZinPC, so the human's desktops are never touched. A sentinel console holds the foreground, a minimized sampler reads the foreground window every 20 ms and names every other title that took it, and the second virtual desktop is created inside the guest.

| Target and desktop | Invoke | Select | Set value | Foreground | Desktop |
| -- | -- | -- | -- | -- | -- |
| WinForms (native Win32), current | Count 0→1 | gamma selected | Field text set | never the target | unchanged |
| WinForms, other | content not exposed | content not exposed | content not exposed | never the target | unchanged |
| Edge page, current and other | refused before the call: `semantic_element_process_changed` | same | same | never the target | unchanged |

On the previous runtime (90c35d96, no guard) the same WinForms run let the target hold the foreground for 39 samples (about 0.8 s), so the check detects the regression. Two consecutive passes on e6d26cb6. The only other title seen was the guest's own `rgnupdt.exe` once after boot, and Program Manager on the new desktop, where a launched console did not take the foreground. Chrome itself was not repeated here; the guest has no Chrome and Edge refuses its page elements. Browser pages are Playwright's job.

## Limits

Notepad's inactive-desktop content provider was unavailable in this run. No missing or unsupported pair counts toward the required successful action categories. A delivered UIA receipt proves neither the app result nor unchanged focus. WPF, UIAccess signing, other app families, physical focus policy and concurrent agents are not qualified here. The owner-accepted capture fallback limitation from LPT-625 is unchanged. Native RFC10/PR11 remain a draft fork experiment, not merged or upstream-ready.
