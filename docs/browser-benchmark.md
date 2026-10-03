# Browser benchmark: I'm Not a Robot

The user chose [Neal's game](https://neal.fun/not-a-robot/) for an untimed, step-by-step browser ergonomics check. Only the owned browser tools interact with the game. After each level, stop for discussion. Do not read site code, hidden state or solutions.

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
