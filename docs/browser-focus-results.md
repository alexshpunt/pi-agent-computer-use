# Focused browser results

[LPT-372](https://linear.app/alexshpunt/issue/LPT-372) passed in the existing Work 03 checkout. No new worktree, IDE change, desktop policy change, browser install or sandbox work was involved.

## What changed

Choose an owned tab once with `browser_focus({tab:1})`; open also focuses its new tab. Acts use short labelled targets such as `{click:"o"}`, without page/observation IDs. Existing Pi Codemode can run four serial actions and request one final observation. Default actions return compact input outcomes, not screenshots.

The saved DOM handles and stale checks remain private. Short labels are not silently rebound after observe, focus changes, navigation, removal, close/reopen or worker replacement. A small allocation checkpoint survives Pi reload. Coordinates remain available, but need a fresh CSS-scale image after any input.

## Verification

- **46 unit tests**, typecheck and **three real-Pi integration contracts** passed. New focused contracts failed before implementation, then passed.
- The real-Pi Codemode contract ran four inputs without intermediate captures, forwarded exactly one final PNG, restored a seeded hint checkpoint and stopped on both refusal and uncertain partial input. The completed partial input was not replayed.
- Native Windows focus check passed **23 operations**: four custom pointer-cursor controls, matching labels, compact actions, fill/submit, removal/navigation/foreign-hint denial and close/reopen isolation.
- Native coordinate check passed **eight operations**, including bounds, explicit wait, stale-scroll denial and cleanup. The storage/tab/cancellation check passed **19 operations**.
- Isolated real-model Pi without IDE used **11 main calls / 22 total including Codemode children**. It made three compact sequences; the four-choice sequence returned Selections:4 and one final PNG. Both form confirmations and clean reopened storage were verified.
- After mandatory reload, the parent Pi focused once, clicked `o`, `p`, `q`, `r` in one Codemode invocation and observed Selections:4. Fill `s` and submit `t` then produced Confirmed:Pi focused browser in one further sequence. No intermediate capture occurred inside either action sequence.
- Actual Windows Chrome capture showed the same four green choices, confirmation and labels `ag`, `ah`, `ai`, `aj` as the agent's final image. `inspect_tui` revisions445 and449 showed the compact calls and readable confirmation in the human's real pane. The stock collapsed TUI hides inline images; the actual browser window displays the labelled page.
- The local parent browser was closed and its fixture stopped. Final read-only discovery found **zero owned browsers, workers or profiles**, and no debugging listener.

[Records](evidence/browser-focus/run.json), [initial native hints](evidence/browser-focus/native-hints.png), [parent selections](evidence/browser-focus/parent-selected.png), [parent confirmation](evidence/browser-focus/parent-confirmed.png), [actual Windows window](evidence/browser-focus/actual-window.png), [human viewport](evidence/browser-focus/parent-viewport.png), [model result](evidence/browser-focus/model-selected.png).

The first real-model export failed because a top-level message accessor cannot read nested Codemode child executions. The exporter was corrected and the already recorded, unchanged model run was rebuilt offline with `PiRun.open`; no second model run was needed. Earlier failed records are not presented as final evidence.

## Limits and game checkpoint

These are local synthetic checks, not general browser compatibility or a speed score. Labels describe the last capture; they grow in long sessions and are not continuously repositioned. Heuristics are bounded to the top document; canvas, iframe, shadow-root and custom controls can still need coordinates. Overlay DOM/style changes may affect some sites. Compact acted means input finished, not verified site success. Optional wait is not automatic readiness.

The disposable browser profile separates personal browser data; it is **not OS isolation**. Only owned tabs are reachable, under either desktop mode.

The untimed game had reached Level3 before this feature, with no Level3 input. Its profile was closed for qualification. See [the benchmark log](browser-benchmark.md); replay from a fresh profile must still pause after each completed level.

## Reproduce

Use `scripts/verify-browser-focus.mjs`, `verify-browser-click.mjs`, `verify-browser-native.mjs` and `live-browser.mjs` only as opt-in native checks on synthetic loopback pages. `live-browser.mjs --from-run <run.jsonl>` rebuilds a saved real-Pi report without running the model. `export-browser-focus-evidence.mjs <own-session.jsonl> <viewport-revision>` exports only this verification's browser records and requires successful owned cleanup. See [the tool guide](browser.md) for setup and boundaries.
