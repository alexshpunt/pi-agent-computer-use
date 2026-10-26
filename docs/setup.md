# Setup, modes and window lifetime

Pi talks to the bundled Windows Cua Driver over owned stdio MCP: directly when Pi runs on Windows, through interop when it runs in WSL. There is no SSH server, permanent service or autostart. This guide covers installation, modes, runtime overrides and window lifetime; [the resource guide](computer-resources.md) covers the tools.

**YOLO is the default.** It reaches new and already open desktop windows within normal user permissions. The user can select Safe, which allows only windows individually opened by this extension session. Neither mode is an OS sandbox. Use only the apps and documents authorized by the actual task.

## Install

```sh
pi install npm:pi-agent-computer-use
```

The package carries the Windows runtime, so no driver download or executable config is needed. From WSL it controls the Windows host, not a Linux desktop. See [the bundled runtime](bundled-runtime.md) for platforms and checks.

Optional parts install with `/computer-setup PART [MACHINE]`: `browser`, `firefox`, `perception`, `mxc`, `vscode-bridge` and `machine`. It works with Pi on Windows and in WSL: each part runs as a PowerShell script on the target Windows, locally or over SSH. Everything goes into the Windows user's own folders, and downloads are checked against pinned SHA-256 sums on that Windows before use. An agent installs a part with Insert `{"action":"setup","part":...}` into a machine address, and only after the user explicitly allows that part.

## Choose a mode

Use `/computer-mode safe` or `/computer-mode yolo` in Pi. `/computer-mode` shows the current choice. The footer and tool results label the mode. Switching needs no reload or per-window config. This is a user command, not a model tool or tool argument.

The selected mode is saved in the Pi session and restored on reload or branch navigation. New sessions start in YOLO. Window ownership and references are not saved: after reload, session replacement, or closing `computer:session`, Safe cannot adopt surviving windows. Open a new window to establish ownership.

Safe hides outside-session windows from discovery and denies their old references before native UI reads or input. Opening a new window does not grant access to another window in the same process. Recycled native handles do not inherit ownership. Launch reuse or ambiguous candidates grant no ownership. The native backend still enumerates window metadata internally to correlate launches and find owned windows; Safe does not hide that metadata from the extension itself.

Switching cannot undo input already dispatched under YOLO. Pending work checks the current policy before dispatch; if the mode changes during a read or input, foreign returned UI state is withheld. Previously received YOLO observations remain in conversation history. Safe does not constrain shell tools, files, network, clipboard, shared app state, or what an authorized app can do.

## Windows and input

Computer use works through `computer:` addresses: the ordinary Pi Agent IDE Read, Search and Delete tools, or `computer_read`, `computer_search` and `computer_delete` without IDE, plus a `computer_*` tool for each action. The `computer_*` tools are deferred, and `tool_search` is turned on.

Opening means a **new window**, not an existing window or new tab. Apps differ: some are single-instance or create several startup windows. If the result is `unknown`, discover what actually appeared before deciding. Never blindly relaunch. A new window is not necessarily an empty document: applications can restore prior state. Read tree and pixels before editing.

A click or scroll on an element goes through UI Automation in the background; points, drags and keys are real input in the foreground. `delivered` does not prove the requested task is complete. Check fresh UI value and PNG. `unknown` may include a partial change; never replay without checking.

Clear or close only task-owned or explicitly authorized documents. Closing `computer:session` releases the runtime; it does not close application windows or save documents.

## Override the runtime

No `.pi/computer-use.json` is needed. An ignored local file in the project can override the driver for an unusual setup:

```json
{
  "command": "/mnt/c/path/to/cua-driver.exe",
  "runtime": "windows-desktop"
}
```

`CUA_DRIVER_PATH` does the same as `command`. `runtime` names a qualified profile from `src/driver.ts`; each profile checks the exact version and SHA-256 of its executable and refuses different bytes before startup. Optional `args` replace `['mcp', '--direct', '--embedded']`, `interop` selects a live WSL interop socket, and `machines` names other machines (see [Work on another machine](computer-resources.md#work-on-another-machine)). These are trusted user settings, never agent tool arguments. Computer use never scans for other installs or updates the driver at startup; close the computer runtime and reload after changing them.

## WSL interop

Windows processes must run in the interactive desktop session, not service Session 0. A long-lived Linux process may inherit a stale `WSL_INTEROP`. If Windows commands hang, check that its socket exists **and** a simple `cmd.exe /d /c ver` succeeds. A live WSL terminal launched from Windows can provide a current endpoint. Keep its owning session alive; do not persist this machine's ephemeral socket as a default.

One-shot PowerShell commands need closed stdin (`</dev/null`). Owned MCP and the window-identity peer intentionally keep stdin open for their protocol and exit on EOF. The wrapper forwards telemetry-off and update-check-off settings through `WSLENV`; it does not edit saved driver preferences.

## Window lifetime and limits

A session-owned PowerShell peer attaches a private marker to each accessible window. Windows destroys that property with the window; a recycled HWND cannot inherit the old reference. Before observation or input, the extension checks PID and marker. On EOF the peer removes its surviving markers. It does not capture UI, send input, launch apps, or elevate permissions.

An inaccessible or elevated window can appear in discovery metadata without a usable reference. The extension does not bypass Windows permissions. References are not recovered across Pi reloads or session replacement. In YOLO, discover again. In Safe, open a new window; discovery cannot adopt surviving windows.

The marker check and driver dispatch are separate native operations, not an atomic OS transaction. New-window matching excludes prelaunch PID/HWND addresses, even if one is recycled during launch, and compares new candidates with the resulting app's windows, including packaged apps that use an existing process. It cannot establish causality against an unrelated concurrent launch of the same app.

## Development

Load exactly one copy of the extension: point its package entry in your Pi settings at the checkout you are working on, and point it back when you are done. Loading the package and a project wrapper together registers every tool twice. In a fresh checkout run `npm ci --ignore-scripts --legacy-peer-deps`, then `npm run dev:ide -- /absolute/path/to/pi-agent-ide` to link the IDE SDK.

```bash
npm run typecheck
npm test
npm rebuild node-pty
npm run test:integration
```

The real-Pi MCP fixtures substitute Windows lifetime identity only; real registration, session logic, MCP, result forwarding and EOF run. Fixtures are not native Windows input evidence.
