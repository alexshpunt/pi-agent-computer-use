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
