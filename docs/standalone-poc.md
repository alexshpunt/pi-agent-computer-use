# Standalone Windows computer use

Pi runs in WSL and talks to Windows Cua Driver over owned stdio MCP. There is no Pi Agent IDE dependency, SSH server, permanent service, or autostart. The tools are experimental, not the final IDE provider API.

**This version is YOLO.** It can reach new and already open desktop windows within normal user permissions. Loading it grants desktop-wide UI capability, not an OS sandbox. Safe mode is a [separate later task](https://linear.app/alexshpunt/issue/LPT-365); [sandbox research](https://linear.app/alexshpunt/issue/LPT-364) is separate too. Use only the apps and documents authorized by the actual task.

## Tools

| Tool | Result |
| --- | --- |
| `computer_apps` | Installed app names and `app_id`, optionally filtered by name. Does not launch. |
| `computer_open` | A genuinely new window's `window_ref`, first accessibility observation, and PNG in one call. |
| `computer_windows` | New and already open window metadata with session `window_ref`; optional app/title filter. |
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

An inaccessible/elevated window can appear in discovery metadata without a usable reference. The extension does not bypass Windows permissions. References are not recovered across Pi reloads; discover again.

The marker check and Driver dispatch are separate native operations, not an atomic OS transaction. Concurrent external destruction or creation during that gap is not independently proven safe. New-window matching compares prelaunch lifetimes with the resulting app's windows, including packaged apps that use an existing process. It cannot establish causality against an unrelated concurrent launch of the same app. Do not claim OS isolation or proven focus/pointer non-interference from these checks.

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

## Contract checks

```bash
npm test
npm rebuild node-pty
npm run test:integration
npm run typecheck
```

The real-Pi MCP fixture substitutes Windows lifetime identity only; real registration, session logic, MCP, result forwarding, and EOF run. Unit checks cover new/existing windows, activation PID mismatch, ambiguous/missing apps, stale/cross-window references, lifetime reuse, cancellation, input uncertainty, and scoped pixel bounds. Fixtures are not native Windows input evidence.

For a read-only native schema probe, set `CUA_DRIVER_PATH` and working inherited `WSL_INTEROP`, then run `npm run probe:driver`. It writes `.tmp/driver-tools.json` without capturing UI or sending input.

[Original PoC result](standalone-poc-results.md) describes the earlier four-tool single-window revision. Current live outcomes and limitations belong in the YOLO result report, not in that historical evidence.
