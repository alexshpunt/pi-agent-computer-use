# Native Windows move and hover

## Question

Can the current public CUA API deliver exact-window pointer movement and hover without clicking for LPT-729?

## Finding

No sufficient public Windows route was found. Window-scope `move_cursor` moves the agent overlay, not the application's pointer. Desktop-scope movement uses global `SetCursorPos` without exact-window capture or element admission. It cannot safely substitute for a window-grounded hover action.

`browser_pointer` supports hover through a bound browser/CDP route. That is not the native desktop capability accepted here.

## Selected runtime check

A metadata-only Windows MCP probe from WSL reached the selected persistent-WGC runtime: CUA 0.34.0, source `841dad7e11619bf7ecba3f98e1c20319cbeb7e52`. It listed 63 tools. No screenshot or input was requested, and the child closed through EOF.

The live `move_cursor` schema describes window movement as overlay-only and desktop movement as the real OS pointer. It has no element token, capture ID, delivery mode or hover dwell. The `browser_pointer` schema needs browser session, target and tab identities and describes CDP or DOM-event input.

Source evidence:

- [Windows MoveCursorTool](https://github.com/alexshpunt/cua/blob/841dad7e11619bf7ecba3f98e1c20319cbeb7e52/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L8317-L8395).
- [Desktop SetCursorPos](https://github.com/alexshpunt/cua/blob/841dad7e11619bf7ecba3f98e1c20319cbeb7e52/libs/cua-driver/rust/crates/platform-windows/src/input/mouse.rs#L992-L995).

A typed window target does not change the native overlay branch into app input.

## Recent upstream

Read-only source research inspected release [0.34.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.34.1), published 2026-10-09, source `0c69d9a2c8abbb5051a2df4a23f0fa166d5385dc`, and upstream main `cfc95fd70369461339e1a7af97b15b1814211c06`. Both keep the same Windows overlay/global movement branches, without a separate native hover tool. The release changes cover GNOME/Wayland capture and delivery, not Windows hover. Neither version was installed or live-qualified here.

## Approved next boundary

The user approved one focused CUA fork addition and isolated Windows/WSL candidate qualification. Production selection and persistent machine settings stay unchanged; candidate adoption needs a separate decision.

Reuse native capture/token admission, coordinate mapping, exact-window identity, delivery guards and cancellation. Expose actual movement without button events, explicit background/foreground policy, bounded hover dwell and truthful pointer/focus receipts.

Global coordinate conversion plus desktop `move_cursor` is rejected: a covered or changed window can send movement to another app.

The user chose a foreground-only native contract. Background refuses without native work. Explicit foreground leaves the target active and the real pointer at the target; no pointer or focus restoration runs. The adapter exposes `move` and `hover`; hover requires `dwell_ms` from 1 to 10000. Both use the fork's `move_pointer` tool.

The focused addition is tracked in [fork RFC #21](https://github.com/alexshpunt/cua/issues/21) and [draft PR #22](https://github.com/alexshpunt/cua/pull/22). It reuses native capture/token admission, checks frozen geometry before input, and bounds pointer arrival and hover dwell. Win32 hit testing and global `SendInput` are not atomic against external desktop changes. This is not OS input isolation or proof of an application hover effect.

The exact candidate `ce28c95175efc97a040cebebd80fec63526aec64` passed its Windows build, strict protocol tests and the two-window production-tool scenario. See [live evidence, reproduction and remaining gates](native-hover-results.md). The byte-checked `windows-native-pointer` profile is opt-in. Earlier profiles remain unavailable for these actions; no production runtime has been replaced.

The live run loaded the isolated worktree loader and `/root/dev/pi/pi-agent-ide`, package 0.8.0, source `394f3784fb3e34a46a1727f3c9cdaf1c5af408ed`, clean and matching fetched origin/develop. Recheck the IDE source before each Pi run.
