# Source identity and capability results

LPT-617 foundation, checked on 7 October 2026. This is not completion of the multi-display/virtual-desktop/concurrent-agent parent LPT-615.

## Contract and real-Pi checks

- 246 unit tests passed with two workers; TypeScript typecheck passed.
- Five related real-Pi integrations passed: complete input, native detail, temporal sequence, held path and key hold.
- New contracts check identity across discovery/observation/action, foreign-session observations refusing before input, native delivery/refusal/unknown evidence, and separate capability receipts for batch steps.
- The real Codemode/MCP integration checks identity and per-step supported, partial and refused results. Synthetic receipts are not Windows qualification.
- The new metadata made maximum batch receipts exceed the pretty-JSON text budget. Existing regression tests caught this; compact JSON now preserves all measured steps before any truncation.

## Production Windows checks after reload

Runtime: the existing qualified Windows key-hold fork at `3b3305044b7b327310615aa99d3307948a63061c`. No binary, permission or persistent machine setup changed.

New disposable Notepad and an isolated Chrome profile on a synthetic localhost page used the same window-first production tools. Discovery, capture and action receipts agreed on agent session, window reference and native PID/HWND. Browser source was `kind: window`, with `native_window` semantic scope and `window_image_pixels`, not page coordinates. Membership remained null rather than inferred from position.

| Attempt | Native evidence | Projection / readback |
| --- | --- | --- |
| Notepad token set_value, requested background | accessibility route; actual delivery unknown | Both modes unknown. Fresh editor readback and pixels contained “LPT-617 disposable”. |
| Shift hold, requested background | background_unavailable; no native input sent | Background unavailable; foreground unknown because this receipt did not include structured escalation. |
| Fresh overview, then explicit foreground Shift hold | global_input; foreground; keys released; 101 ms held for 100 ms requested | Foreground delivered; background unknown. No blanket promise about later holds. |
| Chrome token click on Pause animation, requested background | synthetic_events; background | Background delivered; foreground unknown. Fresh readback/pixels showed Resume animation. |

Reusing the consumed Notepad overview refused before dispatch. No unknown input was replayed.

Notepad later became minimized. Native capture returned no grounding screenshot; the adapter refused without silently restoring or foregrounding it. A failed backend observation retires session resources. This is not evidence of virtual-desktop support or of a geometry-derived lifetime change.

## Human-visible check

`inspect_tui` captured the actual Herdr pane `w3MD:p1`, 161×57 cells, live bottom, revisions 144, 147 and 152. Native delivered/refused summaries were readable. The normal tool renderer collapsed long JSON with an explicit expand indicator. A short projection made the live background/foreground/unknown evidence and attempted-action scope visible without expanding the dump. No malformed borders or escape codes appeared in these results. The debug viewer was not needed for an image-byte change; capture bytes were not changed by this metadata feature.

## Limits and recovery

Initial live opening hit a native identity peer timeout while WSL had about 155 MB available memory and no swap; discovery then reported ENOMEM. The user freed memory. WSL restarted and removed the previous interop socket. The user explicitly approved updating only the ignored local interop path to `/run/WSL/359_interop`; reloading loaded that constructor configuration. Discovery recovered the one task-launched blank Notepad instead of repeating launch.

The browser fixture exited successfully: owned window gone and isolated profile removed. After the user restored the minimized Notepad, a fresh overview showed an empty editor. Background Close did not remove the window. A fresh explicit foreground Close returned unknown (the post-click foreground check failed); discovery then confirmed the window was gone. No replay followed that unknown receipt. The runtime was released.

The qualified native public API still does not expose Windows session, physical monitor or Task View desktop membership. Native foreground escalation is a suggestion, not proof that foreground will work. Other-monitor capture, virtual-desktop management and independent concurrent input still require their own implementation and live checks.

For a new authorized isolated browser reproduction, run `node --experimental-transform-types scripts/open-source-capability-fixture.mjs`, use production computer_* tools on its uniquely titled window, then send `finish` to its terminal. Never target a personal browser profile.
