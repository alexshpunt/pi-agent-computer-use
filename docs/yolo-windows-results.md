# Automatic YOLO Windows opening: results

## Result

[LPT-363](https://linear.app/alexshpunt/issue/LPT-363) passed on 2 October 2026. Pi in WSL opened new Notepad and Calculator windows, returned the first UI observation with each window, and edited an authorized disposable window created outside the model's extension session. No IDE, per-window config, shell-launch tool, or Pi reload was needed during the scenario.

Tested code: [`e464297c83736b06d5d1f66b108db7cacdf9c65d`](https://github.com/alexshpunt/pi-agent-computer-use/commit/e464297c83736b06d5d1f66b108db7cacdf9c65d). Native checks ran against these same source files before the commit. This report is a later documentation-only change.

This qualifies the experimental YOLO path for these two apps. It does not qualify every Windows app, the final IDE provider API, Safe access, or an OS sandbox.

## Environment and setup

- Windows host version reported as `10.0.26200.0`; interactive user desktop, normal permissions.
- WSL2 kernel `6.18.33.2-microsoft-standard-WSL2`, Node `24.20.0`.
- Parent Pi `1.0.0`; repository integration dependency Pi `0.99.1`.
- Windows Cua Driver `0.32.0`, MCP SDK `1.31.0`.
- Isolated model: `openai-codex/gpt-6.1-sol`.
- Existing user-local Driver installation discovered automatically under `AppData/Local/Programs/PiComputerUsePoC/cua-driver-0.32.0/`. WSL interop was inherited, not pinned to an old socket.
- No `.pi/computer-use.json` in the parent worktree or isolated native test workspace. No new app installation, elevation, services, PATH, firewall, or autostart changes.

See [setup and operational rules](standalone-poc.md) for the pinned archive, environment overrides, and tool contract.

## Isolated real-model check

Commands:

```sh
npm test
npm run typecheck
npm run test:integration
node --experimental-transform-types scripts/live-windows.mjs
node scripts/export-native-evidence.mjs
```

The opt-in native script created one new blank, single-tab Notepad canary, then released its preparation runtime. A fresh isolated Pi loaded the actual extension with only the six computer tools and without IDE or user extensions. The canary was the only pre-existing window authorized for UI access.

The model completed the whole scenario in **28 tool calls**, including reads, missing-app refusal, and cleanup. This is a trace count, not a latency comparison or a speedup claim.

| Check | Observation |
| --- | --- |
| Existing-window YOLO access | Canary PID `20436`, HWND `2296582`: discovered in the fresh session, observed blank, edited to `YOLO existing window 363`, verified by fresh editor value and screenshot. |
| First automatic Notepad | HWND `34999596`: new ref plus first tree and PNG; first observation used immediately for input. Fresh editor value and PNG showed `YOLO automatic window 363`. |
| Second automatic Notepad | HWND `91032780`: separate new window while the first and canary remained open. All three Notepad windows shared PID `20436`; refs were distinct. |
| Calculator | PID `27892`, HWND `25759562`: new window with actual Calculator tree and PNG. Its native owner was `ApplicationFrameHost.exe`. |
| Missing app | `PiMissingApp363` returned explicit refusal. No unrelated window was substituted. |
| Cleanup | Written editors cleared and observed blank/unmodified. Single-tab Notepads closed through observed Close Tab; Calculator through observed Close Calculator. Native metadata check found none of the four owned windows. No file saved. |

Native `set_value` returned delivery `unknown` and effect `unverifiable`. Fresh application values and pixels prove the text changed; they do not prove focus non-interference. Background UIA Invoke closed the test windows; acknowledgements alone were not treated as proof of disappearance. Read-only Windows cleanup checks found zero Driver and identity-peer processes.

## Parent Pi and actual human viewport

After reloading the fixed extension, the same automatic-opening flow passed in the main Pi session:

- First Notepad PID `45452`, HWND `9374614`; blank single tab confirmed before input.
- Background `type_text` wrote `Привет! Pi открывает новые окна Windows автоматически. YOLO 363.`. Driver reported UIA ValuePattern, confirmed value readback, and background delivery. Fresh editor value and PNG matched.
- Second Notepad HWND `14551976`, same PID: distinct new window, blank single tab.
- Calculator HWND `44826840`: actual Standard Calculator UI, display `0`.
- `inspect_tui` captured Herdr pane `w3F5:p1`, revision `290`, `274×108` cells at live bottom. Tool names, opening result, YOLO status, refs, and observation IDs were readable and aligned. Stock collapse showed an expand hint; no broken escapes or borders were visible. Inline human PNG display was not required; agent-facing PNGs were received and checked.
- Only the written editor was cleared. Fresh blank/unmodified state and PNG preceded Close Tab. All three owned windows closed through grounded background controls. Discovery returned no Notepad/Calculator windows; observation of the closed first ref was refused.
- `computer_close` released the runtime. Final Windows read-only check: Driver count `0`, identity peer count `0`, owned Notepad process absent. The shared Calculator host was not killed.

## Regression and failure checks

**15 unit tests, one isolated real-Pi MCP fixture, and typecheck passed.** Contracts cover first observation, shared-PID windows, cross-window/stale tokens, handle-lifetime reuse, closed refs, pixel bounds, cancellation before dispatch, missing/ambiguous apps, reused-window launch, interrupted launch/input, no automatic replay, and config permission-boundary changes. The real-Pi fixture uses production tool registration and MCP transport; only Windows lifetime identity is substituted. It is not native Windows proof.

The first native parent attempt exposed a launch-correlation bug: packaged activation reported a broker PID although the new Notepad window belonged to the existing app process. A failing regression reproduced that mismatch. The fix compares new window lifetimes across desktop metadata, correlating returned PID, app name, or reported launch targets. Both final native runs passed on the fix. Earlier failed opening was not silently retried or exported as success; its discovered disposable window was observed and cleaned up.

Background titlebar Close was a no-op in the earlier attempt. A foreground attempt reported unavailable and the window remained. Observed Close Tab used UIA Invoke and worked; the final runs did not need foreground escalation.

## Limits and next work

- YOLO means ordinary desktop-wide permissions, not isolation of files, network, clipboard, shared process state, or app settings. Capability does not authorize unrelated tasks.
- New windows are qualified only for Notepad and Calculator here. Apps may reuse a window/tab or produce several candidates; that returns an honest unknown result rather than false success. Launch is not automatically repeated.
- Session refs bind PID/HWND to a private window-lifetime property and expire on close/reload. Lifetime checks and native dispatch are separate operations, not an atomic OS guard. Concurrent destruction in that gap was not independently tested.
- Launch matching cannot prove causality against a simultaneous unrelated launch of the same app. Inaccessible/elevated windows may not get usable refs; no permission bypass is attempted.
- Native trees reported `elements_complete: false`, even when not truncated. Screenshots and narrowed observations remain necessary; do not assume a complete accessibility tree.
- There is no latency benchmark, generic background-input guarantee, or installation release claim.
- [Safe access, LPT-365](https://linear.app/alexshpunt/issue/LPT-365), follows YOLO as a separate task. [Sandbox research, LPT-364](https://linear.app/alexshpunt/issue/LPT-364), is separate. Pi Agent IDE remains unchanged.

## Tracked evidence

[Compact native trace](evidence/yolo/run.json), [blank canary](evidence/yolo/canary-blank.png), [written canary](evidence/yolo/canary-written.png), [automatic Notepad](evidence/yolo/automatic-written.png), and [Calculator](evidence/yolo/calculator.png). All four PNGs were visually inspected. The export contains only owned test targets and selected results, not full sessions, credentials, or unrelated desktop contents. Disposable raw traces and upload copies are removed after the report and Linear results are stored.
