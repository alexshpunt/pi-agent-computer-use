# Browser benchmark: I'm Not a Robot

The user chose [Neal's game](https://neal.fun/not-a-robot/) as a visible owned-browser ergonomics check. The accepted follow-up goal is to complete the whole game; timers are allowed and the earlier per-level stop rule no longer applies. Only owned browser tools interact with the game. Do not read site code, hidden state or solutions.

**Current checkpoint: paused by the user on 2026-10-03. Levels 1–9 passed; Level 10 is unresolved.** Do not resume until the user gives the next direction. See the [follow-up status](browser-follow-up-status.md) for implemented changes, verification gaps and local evidence. The sections below record earlier runs; their browser states and stop rules are historical.

## First iteration: screenshot click

The initial browser interface could not click Level 1's custom checkbox: it had no semantic element ref. `browser_act` now accepts either an observed element or `x/y` in the latest CSS-scale screenshot. No desktop-wide input or new tool is involved.

After reload, the parent Pi completed Level 1 with one click at `(413,173)` in its fresh 1086×706 image. The click result showed a spinner. One fresh observation then showed **Level 2: Stop Signs**, confirming success. No input was sent on Level 2; the owned browser remains open for the discussion.

This attempt used five browser calls: open, tabs, observe, click, observe. Open returned unknown because navigation occurred during observation. Tabs and observe recovered the existing page without opening a duplicate. No timer ran; this is not a speed score. The earlier blocked attempt used three calls and completed no level.

Two remaining costs are visible: open does not return its known page ref when capture fails, and immediate post-click capture can show a transition rather than its completed result. Neither improvement is implemented in this iteration.

## Verification

- 40 unit tests, typecheck and three real-Pi integration tests passed.
- `node scripts/verify-browser-click.mjs` passed seven native operations on a synthetic custom control with no element refs. Screenshot dimensions matched PNG pixels. The target changed from orange/Clicks: 0 to green/Clicks: 1. Out-of-bounds and replayed input were refused; an independently scrolled page refused stale coordinate input and retained Clicks: 0.
- [Native records](evidence/browser-click/run.json), [before](evidence/browser-click/before.png), [after](evidence/browser-click/clicked.png). The test's browser, worker, profile and fixture server were cleaned up before the game run.
- Parent tool results supplied actual page screenshots and confirmed Level 2. `inspect_tui` captured pane `w3E9:p6`, revision 201: the call sequence and Level 2 text were readable in the real viewport. The stock collapsed renderer does not show inline screenshots; the separate owned browser window shows the page.

This is one checkbox, not a completed game or a general browser compatibility result.

## Second iteration: opening recovery and explicit wait

The user chose both remaining improvements and requested agent-selected `wait_ms`, not automatic readiness detection. Open now retries a refused capture once on the same tab and preserves a known `page_ref` if capture still fails. Actions accept an optional pause of 0..5000 ms after input; the default remains zero.

After reload, Level 1 took **two browser calls instead of five**: open returned a complete observation, then the screenshot click at `(413,173)` with `wait_ms:2000` returned Level 2 directly. No tabs recovery or separate observation was needed. No input was sent on Level 2. The owned game browser is intentionally paused there for discussion.

This reduces model/tool round trips in this attempt, not measured completion time. A two-second pause is not proof that every page is ready.

42 unit tests, typecheck and three real-Pi integrations passed. The native custom-control check passed with a 200 ms delayed update and `wait_ms:300`, including coordinate bounds, stale-scroll refusal and owned cleanup. [New native records](evidence/browser-wait/run.json) are separate from the first iteration's evidence. The retry test proves one backend open, a bounded capture retry and direct recovery through the known ref after repeated capture failure.

`inspect_tui` captured pane `w3E9:p6`, revision 257: both calls, the Level 2 result and the round-trip comparison were readable. The agent also received and checked the actual Level 2 PNG. The collapsed TUI still does not display inline screenshots.

## Third check: Level 2

Before the focused API change, Level 2 (Stop Signs) passed in six browser calls: one observe, four coordinate selections, then Verify by element ref with wait_ms2000. The returned text and PNG showed Level 3 (Wiggles). No Level 3 input was sent; the game was closed before native tests and reload. This is untimed observed progress, not a speed score.

## Fourth check: focused short hints

After [focused hints/Codemode verification](browser-focus-results.md), a fresh owned profile replayed Level 1 in **two browser calls**: open, then `{click:"aq",wait_ms:2000,observe:true}`. The checkbox label was grounded in the actual marked screenshot. The returned text and PNG showed **Level 2: Stop Signs**. No Level 2 input was sent; this game window is intentionally left open for discussion.

No page/observation IDs or coordinate calculation were needed. On the local four-choice qualification, one Codemode invocation ran four compact inputs and one final observation; see the linked report. The game replay itself required only one input, so it does not measure multi-choice batching speed. No timer ran.

`inspect_tui` revision471 in pane `w3E9:p6` showed both browser calls and the readable Level 2 checkpoint. The opening script mistakenly printed the whole structured state, including image base64, before forwarding the PNG. That was caller output misuse, not an additional browser action; later output omitted image data and forwarded it only through `image(...)`.

Remaining ergonomic limits: custom controls can have empty text names, so their labels still need visual grounding; labels grow to two or more letters to avoid silently reusing retired targets; explicit wait is still not page-readiness detection.

## Follow-up checkpoint: Levels 1–9 passed

Stable per-DOM hints, default image-only action results, compact Codemode sequences and region crops were exercised in the parent session. Level 5 passed after visual rotation corrections; Level 6 passed after waiting for the opponent between moves. Level 7 exposed hints on non-interactive text spans, so coordinate input completed the word search. Plate reading and nested stop-sign selection passed Levels 8 and 9.

The last observed browser was at Level 10, Whack-a-Mole. Verify remained disabled despite square selections. The cause is unresolved: this is not proof of a Playwright backend limitation. The browser was left open, but has not been rechecked since the user paused work.

The latest code adds target filtering, disabled-target refusal, a label-visibility toggle, pointer movement and crop-after-compact-scroll support. These final edits are not yet parent-reloaded. Latest checks: 53 unit tests, typecheck, three real-Pi contracts and eight native target operations passed. The native region rerun failed a cross-capture viewport-width assertion (1086 versus 1085); it remains open. The full game and follow-up delivery are not complete. See the linked status report for the distinction between earlier passing evidence and this unfinished checkpoint.