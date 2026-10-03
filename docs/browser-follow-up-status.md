# Browser follow-up: paused checkpoint

[LPT-372](https://linear.app/alexshpunt/issue/LPT-372) is unfinished. The user paused implementation and game testing on 2026-10-03 to discuss a new idea. This update records the current state; it does not approve or start that new direction.

The accepted goal before the pause was to complete the whole Neal game through the visible owned browser, adding and verifying missing browser capabilities as needed. That replaced the earlier per-level stop rule. Do not resume execution until the user gives the next direction.

## Game result

Levels **1–9 passed**. The last observed owned tab was at **Level 10: Whack-a-Mole**, which did not pass. The game browser was left open at the pause. Its continued availability has not been checked since then.

- Level 5 took repeated visual corrections. The eventual rotation sequence passed and returned Level 6. This was a reasoning/perception problem, not evidence that clicks were lost or the page reloaded.
- Level 6 exposed an unsafe batching assumption: the opponent can change the board between moves. A later attempt waited for each response and won.
- Level 7 exposed a real target-discovery defect: hints selected text spans with `pointer-events:none`. Coordinate input completed the word search.
- Levels 8 and 9 passed through visible plate reading and nested square selection. One grounded sequence of 30 selections plus its final image took about two seconds in Codemode. This excludes model thinking and is not an end-to-end speed score.
- Level 10 remains unresolved. Moles appeared and moved; square selection persisted, including eventually all 16 squares. Verify remained disabled. A hint click confirmed the disabled state through Playwright's actionability failure. The remaining problem has not been isolated to reaction latency, puzzle interpretation, or a missing input capability. No backend switch is justified by this result alone.

No site source, hidden game state or external game solutions were used.

## Implemented and checked live in the parent session

These follow-up changes are still uncommitted:

- A DOM node retains its hint across clicks, full observations and same-document history updates. Replacement nodes get new hints.
- The overlay root persists. Image capture updates known label positions after layout changes without rediscovering targets.
- Browser Act returns a PNG by default. `observe:false` supports compact sequences; `observe:true` requests full text, targets and image.
- Image-only observation and viewport-region crops avoid text extraction and target discovery. A crop is not page zoom.
- Input, requested wait, semantic observation and screenshot timings are recorded separately.
- A project skill adapts the inspected OpenAI Computer Use guidance. Research inspected the installed Codex bundle and relevant public OpenAI/Anthropic references. No proprietary source was copied, private Codex runtime connected, or Cua backend equivalence assumed.

Parent proof after reload verified four clicks on one unchanged hint, count 4, one overlay root and an unchanged document token. The region check returned a 100×80 crop after scrolling; a full-viewport coordinate click then produced exactly one click.

Real TUI captures: pane `w3E9:p6`, revisions 886 and 930. They showed readable child calls and image attachments. The stock collapsed terminal did not render inline PNG pixels; actual browser screenshots were inspected separately.

## Latest code: tested, not yet parent-qualified

The last edits added:

- Discovery of the interactive parent instead of a non-interactive pointer-cursor child.
- Disabled state in full target observations and early refusal when a saved target becomes disabled.
- `browser_observe({hints:false})` to hide labels without changing keys; the setting persists for that tab, and `hints:true` restores them.
- `browser_act({move:{x,y}})` for page-scoped pointer movement without a click or global desktop input.
- Region capture after compact scrolling without requiring an extra full image first.

These changes have **not** been reloaded and verified through the parent tools/TUI. The parent session may therefore expose the older API. Hold, drag, mouse-button controls, general key chords and real page zoom have not been implemented in this follow-up.

## Verification at the pause

| Check | Observed result |
| --- | --- |
| Latest unit suite | 53 tests passed across 8 files |
| Latest typecheck | Passed |
| Latest real-Pi contracts | 3 tests passed, including image-only output, region/hint options, movement dispatch and stop-on-failure |
| Native target/visibility/movement check | 8 operations passed; test resources cleaned back to the existing game baseline |
| Earlier native stability check | 36 records passed, including 16 Playwright and 4 scoped Cua clicks, same-document identity and replacement refusal |
| Earlier migrated native checks | Focus 23, coordinate 8 and storage/cancellation 19 passed |
| Earlier real-model run with adapted skill | 22 tool executions passed; isolated run resources cleaned up |
| Latest native region rerun | **Failed:** viewport width 1086 versus 1085 in a cross-capture equality assertion at `scripts/verify-browser-region.mjs:36` |
| Latest parent qualification | Pending for the final edits listed above |
| Full game | Not complete |

The region script had passed six operations before its latest revision. The last failure occurred after the crop dimensions and click-count assertions, while comparing crop metadata with a later full observation. Its cause is unresolved; it must not be relabelled as a passing check or fixed by weakening the assertion without investigation.

## Handoff and evidence

Implementation base: `f67a3e1` on `develop`, Work 03 at `/root/dev/pi/pi-agent-computer-use`. The initial focused-browser delivery at `e9178e2` remains historical evidence in [its report](browser-focus-results.md). Follow-up source, tests, scripts and skill changes remain in the working tree; this checkpoint does not mark them released.

Local evidence awaiting a durable export:

- `.tmp/browser-stability/`: native comparison, parent repeated-click proof and `game-level10.json`.
- `.tmp/browser-region/`: crop PNG, parent crop and latest failed native run.
- `.tmp/browser-targets/`: target/visibility/movement run and labelled, hidden and restored PNGs.
- `.tmp/browser-model/` and `.tmp/native-runs/native-focused-browser/run.jsonl`: the earlier real-model qualification.
- `.tmp/browser-parent/`: actual owned Windows window capture.

Do not delete these artifacts before preserving the useful evidence. Keep historical browser/focus/click/wait evidence unchanged. The Linear Workpad holds the operational recovery notes; the issue owns accepted scope.

## Open work, not a new plan

Wait for the user's new idea before choosing the next implementation direction. Remaining accepted work includes resolving the region failure, parent reload/TUI checks for the latest edits, understanding Level 10, continuing the game, exporting evidence, and reviewing/committing/pushing the unfinished implementation. No new task or backend migration has been started.
