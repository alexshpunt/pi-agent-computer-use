# Standalone Windows PoC

This is an experiment, not the final Pi Agent IDE provider API. Pi runs in WSL and talks to a native Windows Cua Driver process over stdio MCP. There is no IDE dependency, SSH server, daemon service, or automatic startup.

## Tools

- `computer_windows`: list metadata for the operator-configured window.
- `computer_observe`: obtain its accessibility elements and screenshot together.
- `computer_act`: perform one grounded click, text write, select-all, or supported navigation key.
- `computer_close`: release the owned Driver process. It does not close or save application documents.

Every action names the exact PID/window and the latest `observation_id`. A new read retires the previous observation; a dispatched attempt consumes it even if it fails. Element tokens must come from that observation. Coordinates must come from its screenshot. Read again after each attempt.

Background is the first attempt. Foreground is an explicit escalation for the authorized test window, not an automatic retry. A returned input event does not prove the application changed. Check fresh UI state and pixels. If dispatch is interrupted, the result is unknown: the window may have changed.

This target check is an extension guard, not an OS sandbox. Extensions and trusted configuration have the user's normal permissions. The underlying Driver supports more tools than this PoC exposes.

## Set up the Driver

The current pin is **Cua Driver 0.32.0**, source release `cua-driver-rs-v0.32.0` at `66ca6c0833a7e04dd611c473100ba36bbf1f11be`. GitHub marks the release as prerelease. Do not assume a later binary has the same contracts.

For Windows x86_64, use the official [binary archive](https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.32.0/cua-driver-rs-0.32.0-windows-x86_64-binary.zip). Its published SHA-256 is:

```text
16aa3666f4ab4faba2fa6261ecb9349d2e9a0c97eca2a0b0960db5a311c2b1e1
```

Check the archive hash before extracting. Extract its complete contents into a **new user-local directory**, for example `%LOCALAPPDATA%\Programs\PiComputerUsePoC\cua-driver-0.32.0`. Do not overwrite another install. Keep the UIA helper, native library, and other supplied files with the main executable.

Before running the executables, check their Authenticode signatures in Windows PowerShell:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs\PiComputerUsePoC\cua-driver-0.32.0\*.exe" |
  ForEach-Object { Get-AuthenticodeSignature $_.FullName }
```

Expect `Valid` and publisher `Cua AI, Inc.`. This PoC does not need admin, User PATH changes, scheduled tasks, firewall rules, or SSH configuration. The official installer currently defaults autostart on despite a conflicting comment; do not use an unqualified installer one-liner.

## Configure one authorized document

1. Open a **new empty Notepad window with one blank document** yourself. Do not use your own files or a window with other tabs. Modern Notepad can restore earlier tabs, so the empty starting state matters.
2. In WSL, identify its process and main-window handle using Windows PowerShell. This lists only Notepad metadata, not document contents:

```bash
powershell.exe -NoProfile -NonInteractive -Command \
  'Get-Process notepad | Select-Object Id,SessionId,MainWindowHandle,MainWindowTitle | ConvertTo-Json' </dev/null
```

3. Create the ignored local file `.pi/computer-use.json`. Replace these placeholders with your exact executable, PID, and window handle:

```json
{
  "command": "/mnt/c/Users/YOU/AppData/Local/Programs/PiComputerUsePoC/cua-driver-0.32.0/cua-driver.exe",
  "target": { "pid": 12345, "window_id": 123456 }
}
```

The file is **trusted operator configuration**. Optional `args` replace the default `["mcp", "--direct", "--embedded"]` for an explicitly reviewed transport. They are not model-callable shell arguments. Changing the configured window requires reloading Pi; `computer_close` invalidates observations but does not reread configuration.

### WSL interop problems

The Windows process must land in the interactive desktop session, not service Session 0. Our first launch reported Session 1.

An old long-lived Linux process may inherit a stale `WSL_INTEROP`. If Windows commands hang, first check whether its socket exists and whether a simple `cmd.exe /d /c ver` works. A live WSL terminal launched from Windows can provide a current endpoint. You can set the optional `interop` field to that socket path in local configuration; keep the owning terminal session alive. Do not copy our machine's endpoint as a default or install a Linux Driver to control Windows.

One-shot PowerShell commands must close stdin (`</dev/null` above). Leaving terminal stdin open caused hangs in the tested setup. MCP is different: its stdin intentionally carries the protocol until cleanup sends EOF.

The wrapper forwards telemetry-off and update-check-off environment variables to Windows through `WSLENV`. It does not change the user's saved Driver preferences.

## Run standalone

In the checkout:

```bash
npm install --ignore-scripts
pi --no-extensions --no-skills --no-context-files --no-prompt-templates \
  -e ./src/index.ts --tools computer_windows,computer_observe,computer_act,computer_close
```

This explicit invocation does not load Pi Agent IDE. The tracked `.pi/extensions/computer-use.ts` is only the project's development entry point; it does not install anything globally.

For a **live model-driven qualification**, after authorizing the empty window:

```bash
npm rebuild node-pty
node scripts/live-notepad.mjs
```

This uses your configured Pi model and credentials in an isolated Pi process with only the PoC tools. It edits the authorized document and leaves it open for the parent/user to inspect. Results go into ignored `.tmp/native-runs` and `.tmp/native-live-summary.json`. A passing run still needs screenshot/TUI judgement and cleanup of the owned test document without saving. Do not run it against existing files or multiple tabs.

The script is opt-in, not part of normal automated tests.

To keep compact evidence after a passing run, use `node scripts/export-native-evidence.mjs`. It exports only the owned window's initial/final PNGs and action results to `docs/evidence`; it does not copy the full session or credentials.

The agent receives screenshots even when the terminal cannot display inline images. The current PoC uses Pi's standard text renderer. Human-visible image previews are not required for this experiment.

## Contract checks

```bash
npm test
npm rebuild node-pty
npm run test:integration
npm run typecheck
```

The isolated real-Pi contract test uses a deterministic MCP fixture. It checks loading, structured observation, stale-write refusal, and child EOF cleanup. It is **not** evidence of Windows accessibility or input reliability.

For a read-only native capability probe, set `CUA_DRIVER_PATH` to the Windows executable path visible from WSL, set a working `WSL_INTEROP` when needed, and run `npm run probe:driver`. It writes the actual runtime tool schemas under `.tmp` and never captures a desktop or dispatches UI input.

## Qualification limits

The accepted first scenario is an owned Windows Notepad document: insert `Pi computer use PoC 123`, edit it to `Pi computer use PoC 456`, and confirm fresh application state plus screenshot. Browser support, other applications, background reliability, latency, and production safety are separate questions. A source review, handshake, mock test, or model's claim of success cannot establish those.
