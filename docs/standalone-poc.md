# Standalone Windows computer use

Pi runs in WSL and talks to Windows Cua Driver over owned stdio MCP. There is no Pi Agent IDE dependency, SSH server, permanent service, or autostart. The tools are experimental, not the final IDE provider API.

**YOLO is the default.** It reaches new and already open desktop windows within normal user permissions. The user can select Safe, which allows only windows individually opened by this extension session. [Safe qualification](safe-windows-results.md) is recorded in [LPT-365](https://linear.app/alexshpunt/issue/LPT-365). Neither mode is an OS sandbox; [sandbox research](https://linear.app/alexshpunt/issue/LPT-364) is separate. Use only the apps and documents authorized by the actual task.

## Choose a mode

Use `/computer-mode safe` or `/computer-mode yolo` in Pi. `/computer-mode` shows the current choice. The footer and tool results label the mode. Switching needs no reload or per-window config. This is a user command, not a model tool or tool argument.

The selected mode is saved in the Pi session and restored on reload or branch navigation. New sessions start in YOLO. Window ownership and references are not saved: after reload, session replacement, or `computer_close`, Safe cannot adopt surviving windows. Open a new window to establish ownership.

Safe hides outside-session windows from discovery and denies their old references before native UI reads or input. Opening a new window does not grant access to another window in the same process. Recycled native handles do not inherit ownership. Launch reuse or ambiguous candidates grant no ownership. The native backend still enumerates window metadata internally to correlate launches and find owned windows; Safe does not hide that metadata from the extension itself.

Switching cannot undo input already dispatched under YOLO. Pending work checks the current policy before dispatch; if the mode changes during a read or input, foreign returned UI state is withheld. Previously received YOLO observations remain in conversation history. Safe does not constrain shell tools, files, network, clipboard, shared app state, or what an authorized app can do.

## Tools

| Tool | Result |
| --- | --- |
| `computer_apps` | Installed app names and `app_id`, optionally filtered by name. Does not launch. |
| `computer_open` | A genuinely new window's `window_ref`, first accessibility observation, and PNG in one call. |
| `computer_windows` | Permitted window metadata with session `window_ref`; optional app/title filter. Safe lists only session-opened windows. |
| `computer_observe` | Fresh accessibility elements and scoped PNG for a reference. |
| `computer_act` | One grounded text/value/click/select-all/navigation action. |
| `computer_close` | Release owned Driver and lifetime peer; invalidate references. Does not close apps or save files. |

For example, ask `computer_open` for `{"app":"Notepad"}`. It resolves the installed app, launches once, finds the new window, and returns the first observation. The agent does not need a configured PID/HWND, a shell launch, or a reload. Use an exact installed name or the `app_id` from `computer_apps` for other apps. The optional `Windows` name prefix and `.exe` suffix are ignored for matching. No model-supplied command line is accepted.

Opening means a **new window**, not an existing window or new tab. Apps differ: some are single-instance or create several startup windows. If the result is `unknown`, discover what actually appeared before deciding. Never blindly relaunch. A new window is not necessarily an empty document: applications can restore prior state. Read tree and pixels before editing.

Actions use `window_ref`, the latest `observation_id`, and an observed `element_token` or coordinates inside that screenshot. Observing one window replaces only its earlier observation. Dispatch consumes it, including failed attempts. Read again after each action.

Background is the default. Foreground is explicit and only follows an observed background refusal/no-op. `delivered` does not prove the requested task is complete. Check fresh UI value and PNG. `unknown` may include a partial change; never replay without checking.

For disposable single-tab Notepad cleanup, clear only your text, verify blank/unmodified state, then use the observed **Close Tab** control. Its background UIA Invoke worked in qualification. Titlebar Close is different: background synthetic clicks were no-ops. Clear/close only task-owned or explicitly authorized documents. `computer_close` does not do this for you.

## Install the Driver once

The pin is **Cua Driver 0.32.0**, source release `cua-driver-rs-v0.32.0` at `66ca6c0833a7e04dd611c473100ba36bbf1f11be`. GitHub marks it prerelease. Later binaries need fresh qualification.

For Windows x86_64 use the official [binary archive](https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0/cua-driver-rs-0.32.0-windows-x86_64-binary.zip). Published SHA-256:

```text
16aa3666f4ab4faba2fa6261ecb9349d2e9a0c97eca2a0b0960db5a311c2b1e1
```

Check the hash before extraction. Extract the **whole archive** into a new user-local directory, for example `%LOCALAPPDATA%\Programs\PiComputerUsePoC\cua-driver-0.32.0`. Do not overwrite another install. Keep supplied native libraries and UIA helper beside the executable.

Check signatures before running executables:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs\PiComputerUsePoC\cua-driver-0.32.0\*.exe" |
  ForEach-Object { Get-AuthenticodeSignature $_.FullName }
```

Expect `Valid`, publisher `Cua AI, Inc.`. No admin, PATH changes, scheduled tasks, firewall rules, or SSH setup are needed. Do not use an unqualified installer one-liner: the inspected installer enabled autostart by default.

## No per-window setup

The extension finds the above install automatically under Windows user profiles mounted at `/mnt/c/Users` (or `%LOCALAPPDATA%` in native Windows). If zero or several installs match, set `CUA_DRIVER_PATH` to the intended executable. It does not install or update the Driver automatically.

No `.pi/computer-use.json` is required. For an unusual environment, an ignored local file can override the trusted executable or transport:

```json
{
  "command": "/mnt/c/Users/YOU/AppData/Local/Programs/PiComputerUsePoC/cua-driver-0.32.0/cua-driver.exe"
}
```

Optional `args` replace `['mcp', '--direct', '--embedded']`; optional `interop` selects a live WSL interop socket. These are trusted user settings, not agent-callable executable arguments. The old `target` field is rejected rather than silently changing its permission boundary. Remove old single-window PoC configuration before using YOLO. Environment overrides are read when the session is first used; ordinary opening and window selection never need a reload.

### WSL interop

Windows processes must run in the interactive desktop session, not service Session 0. A long-lived Linux process may inherit a stale `WSL_INTEROP`. If Windows commands hang, check that its socket exists **and** a simple `cmd.exe /d /c ver` succeeds. A live WSL terminal launched from Windows can provide a current endpoint. Keep its owning session alive; do not persist this machine's ephemeral socket as a default. A Linux Driver does not control the Windows host desktop.

One-shot PowerShell commands need closed stdin (`</dev/null`). Owned MCP and the window-identity peer intentionally keep stdin open for their protocol and exit on EOF. The wrapper forwards telemetry-off and update-check-off settings through `WSLENV`; it does not edit saved Driver preferences.

## Window lifetime and limits

A session-owned PowerShell peer attaches a private marker to each accessible window. Windows destroys that property with the window; a recycled HWND cannot inherit the old reference. Before observation or input, the extension checks PID and marker. On EOF the peer removes its surviving markers. It does not capture UI, send input, launch apps, or elevate permissions.

An inaccessible/elevated window can appear in discovery metadata without a usable reference. The extension does not bypass Windows permissions. References are not recovered across Pi reloads or session replacement. In YOLO, discover again. In Safe, open a new window; discovery cannot adopt surviving windows.

The marker check and Driver dispatch are separate native operations, not an atomic OS transaction. Concurrent external destruction or creation during that gap is not independently proven safe. New-window matching excludes prelaunch PID/HWND addresses, even if one is recycled during launch, and compares new candidates with the resulting app's windows, including packaged apps that use an existing process. It cannot establish causality against an unrelated concurrent launch of the same app. Do not claim OS isolation or proven focus/pointer non-interference from these checks.

## Run without IDE

```bash
npm install --ignore-scripts
pi --no-extensions --no-skills --no-context-files --no-prompt-templates \
  -e ./src/index.ts --tools computer_apps,computer_open,computer_windows,computer_observe,computer_act,computer_close
```

The tracked `.pi/extensions/computer-use.ts` is only this project's development entry point. Nothing is installed globally.

For opt-in real-model Windows qualification:

```bash
npm rebuild node-pty
node --experimental-transform-types scripts/live-windows.mjs
```

This creates an empty disposable canary outside the isolated model's extension session, then tests existing-window YOLO access, two new Notepad windows, Calculator, missing-app refusal, and unsaved cleanup. The isolated model has only the six computer tools, no IDE or shell. It uses your configured model/credentials. Do not run while you need uninterrupted desktop focus. If a run fails, inspect its owned test windows and clean them up; do not rerun blindly.

Artifacts stay in ignored `.tmp/native-runs` and `.tmp/native-yolo-summary.json`. After a passing run, `node scripts/export-native-evidence.mjs` exports compact owned-window evidence to `docs/evidence/yolo`. Judge actual screenshots and the real Pi viewport too. Human inline images are not required; PNG must still reach the agent.

### Safe qualification

This check needs the user's actual `/computer-mode` commands. Do not turn the command into an agent tool or silently change mode in a test presented as user input.

1. Start in YOLO. Run `node --experimental-transform-types scripts/prepare-safe-canary.mjs` once. It creates only one new empty Notepad, saves its exact target and scoped PNG in `.tmp`, then releases its backend. Inspect the new window's tree and pixels. Do not rerun blindly or select another existing document.
2. In the interactive extension, discover only that authorized canary, observe it, write `SAFE canary 365`, and verify the value and PNG. Run `node --experimental-transform-types scripts/check-safe-denial.mjs`. Its real Driver adapter must record zero native calls during Safe denial and an unchanged canary afterward. Its mode callback is a trusted test controller, not interactive user-command evidence.
3. Have the user select Safe. Open one new Notepad through `computer_open`, confirm an empty single tab, write `SAFE owned 365`, and verify. Have the user select YOLO; the owned reference must survive. Discover and observe the exact canary, obtaining its current reference and observation.
4. Have the user select Safe again. Attempt a read and write through that old canary reference: both must return explicit policy refusal. Discovery must show only the owned window, even when the PID is shared. Update its editor to `SAFE owned 365 after switch` and verify. Capture the actual Safe notification, denial text, and footer with `inspect_tui`.
5. Have the user return to YOLO. Read the same canary reference and verify its text is unchanged. Clear only the test editors, observe blank/unmodified single tabs, and close their observed Close Tab controls without saving. Verify the exact test windows are gone, release the backend, and record a read-only Windows process/handle cleanup result in `.tmp/safe-cleanup.json`.

After a passing run, export only its owned evidence:

```bash
node scripts/export-safe-evidence.mjs <own-pi-session.jsonl> <owned-window-id> <inspected-pane-revision>
```

The export uses the actual Pi tool PNGs, selected viewport capture, native denial record, and cleanup record. It keeps compact results in `docs/evidence/safe`, not the whole private session. Session replacement invalidates ownership and references; an interrupted setup is not a passing mode-transition test.

## Contract checks

```bash
npm test
npm rebuild node-pty
npm run test:integration
npm run typecheck
```

The real-Pi MCP fixture substitutes Windows lifetime identity only; real registration, session logic, MCP, result forwarding, and EOF run. Unit checks cover new/existing windows, activation PID mismatch, ambiguous/missing apps, stale/cross-window references, lifetime reuse, cancellation, input uncertainty, and scoped pixel bounds. Safe checks also cover old refs, shared-PID siblings, runtime ownership loss, user-command restoration, invalid policy arguments, and mode changes during queued/native work. Fixtures are not native Windows input evidence.

For a read-only native schema probe, set `CUA_DRIVER_PATH` and working inherited `WSL_INTEROP`, then run `npm run probe:driver`. It writes `.tmp/driver-tools.json` without capturing UI or sending input.

[Original PoC result](standalone-poc-results.md) describes the earlier four-tool single-window revision. See [the YOLO result report](yolo-windows-results.md) for current live outcomes and limitations.
