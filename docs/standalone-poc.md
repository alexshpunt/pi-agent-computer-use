# Standalone Windows computer use

Pi runs in WSL and talks to Windows Cua Driver over owned stdio MCP. There is no SSH server, permanent service, or autostart. This guide covers setup, runtime selection and window lifetime; [the resource guide](computer-resources.md) covers the tools.

**YOLO is the default.** It reaches new and already open desktop windows within normal user permissions. The user can select Safe, which allows only windows individually opened by this extension session. Neither mode is an OS sandbox. Use only the apps and documents authorized by the actual task.

## Choose a mode

Use `/computer-mode safe` or `/computer-mode yolo` in Pi. `/computer-mode` shows the current choice. The footer and tool results label the mode. Switching needs no reload or per-window config. This is a user command, not a model tool or tool argument.

The selected mode is saved in the Pi session and restored on reload or branch navigation. New sessions start in YOLO. Window ownership and references are not saved: after reload, session replacement, or closing `computer:session`, Safe cannot adopt surviving windows. Open a new window to establish ownership.

Safe hides outside-session windows from discovery and denies their old references before native UI reads or input. Opening a new window does not grant access to another window in the same process. Recycled native handles do not inherit ownership. Launch reuse or ambiguous candidates grant no ownership. The native backend still enumerates window metadata internally to correlate launches and find owned windows; Safe does not hide that metadata from the extension itself.

Switching cannot undo input already dispatched under YOLO. Pending work checks the current policy before dispatch; if the mode changes during a read or input, foreign returned UI state is withheld. Previously received YOLO observations remain in conversation history. Safe does not constrain shell tools, files, network, clipboard, shared app state, or what an authorized app can do.

## Tools

Computer use works through `computer:` addresses: the ordinary Pi Agent IDE Read, Search, Write and Insert tools, or `computer_read`, `computer_search`, `computer_write` and `computer_insert` without IDE. See [the resource guide](computer-resources.md) for addresses, views and commands.

Opening means a **new window**, not an existing window or new tab. Apps differ: some are single-instance or create several startup windows. If the result is `unknown`, discover what actually appeared before deciding. Never blindly relaunch. A new window is not necessarily an empty document: applications can restore prior state. Read tree and pixels before editing.

Background is the default. Foreground is explicit and only follows an observed background refusal/no-op. `delivered` does not prove the requested task is complete. Check fresh UI value and PNG. `unknown` may include a partial change; never replay without checking.

Clear or close only task-owned or explicitly authorized documents. Closing `computer:session` releases the runtime; it does not close application windows or save documents.

## Install the extension

```sh
pi install npm:pi-agent-computer-use
```

The package carries the Windows runtime. No manual CUA download or executable config is needed. WSL controls the Windows host, not a Linux desktop. See [the bundled runtime, system requirements and platform boundary](bundled-runtime.md).

The following separate-driver setup is retained only for trusted legacy overrides. It is not the default installation.

## Optional legacy Driver setup

The pin is **Cua Driver 0.33.2**, official release `cua-driver-rs-v0.33.2`. Window, display and browser routes share this qualified pin. GitHub marks the monorepo release as prerelease; the archive uses a plain stable version. Later binaries need fresh qualification, not automatic startup upgrades.

For Windows x86_64 use the official [binary archive](https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.33.2/cua-driver-rs-0.33.2-windows-x86_64-binary.zip). Published SHA-256:

```text
82fd647e6f4b69ed811e52e9586a4e56291e477ad699fb02441193a45364337c
```

Check the hash before extraction. Extract the **whole archive** into a new user-local directory, for example `%LOCALAPPDATA%\Programs\PiComputerUsePoC\cua-driver-0.33.2`. Do not overwrite another install. Keep supplied native libraries and UIA helper beside the executable.

Check signatures before running executables:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Programs\PiComputerUsePoC\cua-driver-0.33.2\*.exe" |
  ForEach-Object { Get-AuthenticodeSignature $_.FullName }
```

Expect `Valid`, publisher `Cua AI, Inc.`. No admin, PATH changes, scheduled tasks, firewall rules, or SSH setup are needed. Do not use an unqualified installer one-liner: the inspected installer enabled autostart by default.

## No per-window setup

The extension selects the installed native package automatically. To use a separate legacy executable instead, set `CUA_DRIVER_PATH` or a trusted local `command`. It does not scan user profiles for legacy installs or update CUA at startup.

No `.pi/computer-use.json` is required. For an unusual environment, an ignored local file can override the trusted executable or transport:

```json
{
  "command": "/mnt/c/Users/<user>/AppData/Local/Programs/PiComputerUsePoC/cua-driver-0.33.2/cua-driver.exe"
}
```

Optional `args` replace `['mcp', '--direct', '--embedded']`; optional `interop` selects a live WSL interop socket. These are trusted user settings, not agent-callable executable arguments. The old `target` field is rejected rather than silently changing its permission boundary. Remove old single-window PoC configuration before using YOLO. Environment overrides are read when the session is first used; ordinary opening and window selection never need a reload.

### Qualified continuous paths

The bundle includes the pinned Windows fork routes. To use the older separately qualified held-path artifact instead, select it in the ignored local config:

```json
{
  "command": "/absolute/path/to/qualified/artifact/runtime/cua-driver.exe",
  "runtime": "windows-held-paths"
}
```

This is trusted user setup, not an agent tool parameter. Selection does not install or replace a runtime. The executable must match the exact source/version/SHA-256 in `HELD_PATH_RUNTIME` in `src/driver.ts`; different bytes refuse before startup. Fork arguments are fixed to owned direct embedded MCP. The adapter sets child-local `CUA_DRIVER_MCP_ENVELOPES=1` and requires the upstream EOF-aware capability. Default serial MCP cannot cancel a held path safely on EOF.

Keep the supplied runtime companions beside the executable. Do not change signing trust, elevation or OS policy to run it. `scripts/install-cua-held-path.ps1 -Artifact <downloaded-CI-directory>` installs the exact checked artifact into a separate user-local `cua-driver-0.34.0-held-bba07a9` directory. It verifies all three executable hashes, keeps notices/build metadata and refuses to overwrite an existing directory. It changes no PATH, services, registry, autostart or trust settings. If UNC script execution is refused, execute the reviewed installer text with PowerShell `ScriptBlock.Create`; do not change execution policy or install modules.

The key-hold selection below can replace this local choice. Close the current computer runtime and reload after a selection change. Remove the local selection to return to the bundled runtime; no startup update runs.

### Qualified key holds

For bounded keys and modifier-held pointer work, explicitly select `runtime:"windows-key-holds"` with the permanent qualified executable. The exact version/source/hash is `KEY_HOLD_RUNTIME` in `src/driver.ts`; both forks use fixed owned MCP arguments and the acknowledged EOF receiver above. The older mouse-path fork cannot hold keys.

`scripts/install-cua-key-hold.ps1 -Artifact <downloaded-CI-directory>` installs a checked key-hold artifact into a separate user-local `cua-driver-0.34.0-keys-3b330504` directory. The installer verifies all three EXEs, preserves notices/metadata and refuses overwrite. Older directories remain available. No automatic installation or OS setting change occurs. Select this trusted local runtime, close the current runtime and reload.

### WSL interop

Windows processes must run in the interactive desktop session, not service Session 0. A long-lived Linux process may inherit a stale `WSL_INTEROP`. If Windows commands hang, check that its socket exists **and** a simple `cmd.exe /d /c ver` succeeds. A live WSL terminal launched from Windows can provide a current endpoint. Keep its owning session alive; do not persist this machine's ephemeral socket as a default. A Linux Driver does not control the Windows host desktop.

One-shot PowerShell commands need closed stdin (`</dev/null`). Owned MCP and the window-identity peer intentionally keep stdin open for their protocol and exit on EOF. The wrapper forwards telemetry-off and update-check-off settings through `WSLENV`; it does not edit saved Driver preferences.

## Window lifetime and limits

A session-owned PowerShell peer attaches a private marker to each accessible window. Windows destroys that property with the window; a recycled HWND cannot inherit the old reference. Before observation or input, the extension checks PID and marker. On EOF the peer removes its surviving markers. It does not capture UI, send input, launch apps, or elevate permissions.

An inaccessible/elevated window can appear in discovery metadata without a usable reference. The extension does not bypass Windows permissions. References are not recovered across Pi reloads or session replacement. In YOLO, discover again. In Safe, open a new window; discovery cannot adopt surviving windows.

The marker check and Driver dispatch are separate native operations, not an atomic OS transaction. Concurrent external destruction or creation during that gap is not independently proven safe. New-window matching excludes prelaunch PID/HWND addresses, even if one is recycled during launch, and compares new candidates with the resulting app's windows, including packaged apps that use an existing process. It cannot establish causality against an unrelated concurrent launch of the same app. Do not claim OS isolation or proven focus/pointer non-interference from these checks.

## Run without Pi Agent IDE

Without Pi Agent IDE, or with an IDE whose plugin API version does not match, computer use registers deferred `computer_read`, `computer_search`, `computer_write` and `computer_insert` tools and turns `tool_search` on. See [the resource guide](computer-resources.md).

Normal sessions load the globally configured package. There is no tracked project extension loader: loading both the package and a wrapper registers the same tools twice. For development, point the package entry in your Pi settings at the checkout you are working on, install its dependencies, and point the entry back when you are done.

## Contract checks

```bash
npm test
npm rebuild node-pty
npm run test:integration
npm run typecheck
```

The real-Pi MCP fixture substitutes Windows lifetime identity only; real registration, session logic, MCP, result forwarding, and EOF run. Unit checks cover new/existing windows, activation PID mismatch, ambiguous/missing apps, stale/cross-window references, lifetime reuse, cancellation, input uncertainty, and scoped pixel bounds. Safe checks also cover old refs, shared-PID siblings, runtime ownership loss, user-command restoration, invalid policy arguments, and mode changes during queued/native work. Fixtures are not native Windows input evidence.

For a read-only native schema probe, set `CUA_DRIVER_PATH` and working inherited `WSL_INTEROP`, then run `npm run probe:driver`. It writes `.tmp/driver-tools.json` without capturing UI or sending input.

[The resource guide](computer-resources.md) describes the current tools.
