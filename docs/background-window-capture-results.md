# Background window capture: results

LPT-625 qualified fresh pixels from covered and other-desktop Chrome and Notepad windows on the current Windows host. The owner accepted the existing native fallback risk and chose to finish without changing CUA. This is a bounded qualification, not a universal window-only guarantee. [Sanitized evidence](evidence/background-window-capture/qualification.json) records the tested rows, hashes and foreground measurements.

## Exact runtime

The installed Windows fork is CUA 0.34.0, source `506239da08cfdafa63dac1857f5471752fb70f5e`. Its driver SHA256 is `0e25c8b83fd48b54be479eb128452a6f6b099b5ff6ce2d20bac024eda07ead16`. No runtime or machine setting changed during these checks.

## Disposable live checks

Only an isolated Chrome target, a new Notepad containing test text and a separate isolated Chrome sentinel were used. The opt-in runner is `scripts/verify-background-window-capture.mjs --live-approved`, run with Node's `--experimental-transform-types` option. The runner creates the browser profiles and marker server; production `computer_*` tools perform the measured captures. It never switches virtual desktops.

| State | Chrome | Notepad |
| --- | --- | --- |
| Fully covered on the current desktop | Blue MARKER 1 changed to green MARKER 2 | MARKER A changed to MARKER B |
| On another existing shell desktop | Green MARKER 2 changed to blue MARKER 3 | MARKER B changed to MARKER C |

Each returned image showed the expected target content, not the purple covering window. Both targets had physical bounds 900×800 at (150,180). The covering sentinel was 1200×1100 at (70,70), ahead of both targets in native z-order. Returned images were 500×444. Window references and native lifetimes remained the same.

For the other-desktop checks, sampled target GUIDs differed from the sentinel's GUID and both target current-desktop flags were false. The owner did the moves and setup visits. The first attempted placement did not match native membership, so no off-desktop pass was counted until placement was corrected and independently read back.

Notepad's text was changed in a separate owner setup visit before returning to the sentinel. Chrome's marker changed through its own fixture polling while off-desktop. No target input or desktop switch was requested during measured reads. Notepad exposed only five partial UI elements off-desktop; its missing editor structure was not treated as proof of pixel freshness.

A read-only Windows foreground sampler ran around the capture batches. Every sample in each accepted batch named the sentinel. Sampling requested 20 ms, but observed gaps were about 30 ms with maxima of 47–48 ms in the initial batches. This is bounded sampling, not proof against arbitrarily short focus changes. Windows sampler times and WSL tool times are separate clocks; the begin/read/end command order defines the measurement interval, not a claimed cross-clock timestamp alignment. Sentinel page focus events supplement the native samples. Owner setup visits are outside these intervals.

## Failure found

After minimizing the disposable Chrome in a separate setup phase, native `get_window_state` returned zero images and a concrete `screenshot_error`: the minimized window has no rendered content. The adapter instead reported only “Driver returned no grounding screenshot.”

The focused adapter fix preserves the bounded native reason in a refused result. It publishes no pixels, UI tokens, image/detail IDs or input grant. A failed read retires the previous observation. Revocation and changed native lifetime withhold the diagnostic as well. UI-only reads remain independent of screenshot failure.

The regression was red before the fix. Five unit checks cover the native reason, retired input, contradictory image bytes, lifetime replacement, access revocation and UI-only independence. A real-Pi test exercises the MCP/tool/Codemode boundary and confirms no input, restore or activation call occurs.

After reloading the production extension, a new blank Notepad was minimized in a separate setup phase. Background minimize was ineffective; explicit foreground minimize returned an unknown receipt, then the next full read confirmed the minimized state through the native refusal. The result kept the concrete “no rendered content” reason and returned no image, UI or observation ID. A later UI-only read succeeded without pixels. A final live stale-input attempt lacked an observation ID and is not counted; the unit and real-Pi regressions verify that contract. The sole blank, unmodified tab was closed through UIA and discovery confirmed the task window absent. No document text was added in this final check.

## Remaining contract gap

The inspected native producer can fall back to a screen-region capture. Its public window wrapper drops the internal occlusion flag. The four successful live rows do not establish that all failure/fallback paths are safe: those paths could still expose another window's pixels as a successful target capture.

The owner later declined changing this native fallback and chose to complete LPT-625 with the limitation recorded. This supersedes the earlier native-fix approval. No native edit or runtime change was made, and no report was sent. The four qualified rows are valid evidence for the tested apps and host, not a strict window-only guarantee across all native paths.

Protected content, arbitrary applications, other Windows login sessions and general cross-desktop input are not qualified. The task does not add a backend or change Safe/YOLO policy. All three task windows are now absent and both isolated profiles were removed with native readback. Cleanup was owner-assisted after native ownership refused the runner's process-termination fallback; it was not a successful automatic cleanup. Notepad's text was cleared, verified empty and its sole blank tab closed through UIA. The earlier Herdr checkpoint (pane w3MD:pA, revision 666, 304×108 cells) showed readable progress and the cleanup request.

## Final verification

- 308 unit tests across 35 files passed with two workers.
- Four related real-Pi integrations passed: capture failure, observation granularity, native detail and unified tools.
- Typecheck, both helper syntax checks and Git whitespace checks passed.
- Production refusal was reproduced after extension reload on the unchanged installed driver.
- Actual Herdr viewport w3MD:pB, revision 136, 188×57 cells showed the native-reason, withheld-authority and cleanup summary clearly, without clipping. The failed stale-input attempt was visible and was not reported as a pass.

The harness now records each automatic close outcome instead of aborting before trying the second fixture. That cleanup revision has syntax coverage, not a new live automatic-cleanup qualification. The recorded browser cleanup remains owner-assisted.
