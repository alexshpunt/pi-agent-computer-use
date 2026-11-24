# Changelog

## 0.2.2 — 2026-11-24

### Fixed

- A remote machine on a slow link gets a new runtime after a pin change. The machine downloads the pinned files from the release itself and checks their hashes; only a file that does not arrive intact is sent over SSH. The copy also continues when the tool call that started it times out, and the next use of the machine waits for it instead of starting over.
- Programs that `computer_open` starts from Pi on Windows run native programs again. The driver had only the short environment of the MCP stdio transport, so a launched PowerShell got `PATHEXT=.CPL` and refused to run `.exe` files ("Cannot run a document in the middle of a pipeline"). The driver now also gets the Windows variables that describe the machine, such as `PATHEXT`, `WINDIR` and `ComSpec`; Pi's other variables, including keys, stay out.
- A program that `computer_open` starts without a window, such as a hidden script, is reported as started with its process ID instead of an unknown outcome. A launch that goes to a window that already existed is still reported as unknown.

## Unreleased

### Fixed

- A remote machine on a slow link gets a new runtime after a pin change. The machine downloads the pinned files from the release itself and checks their hashes; only a file that does not arrive intact is sent over SSH. The copy also continues when the tool call that started it times out, and the next use of the machine waits for it instead of starting over.
- Programs that `computer_open` starts from Pi on Windows run native programs again. The driver had only the short environment of the MCP stdio transport, so a launched PowerShell got `PATHEXT=.CPL` and refused to run `.exe` files ("Cannot run a document in the middle of a pipeline"). The driver now also gets the Windows variables that describe the machine, such as `PATHEXT`, `WINDIR` and `ComSpec`; Pi's other variables, including keys, stay out.
- A program that `computer_open` starts without a window, such as a hidden script, is reported as started with its process ID instead of an unknown outcome. A launch that goes to a window that already existed is still reported as unknown.

## 0.2.1 — 2026-11-24

### Fixed

- Foreground input, such as a drag on Paint's canvas, hands the foreground back to the human's window again when Windows first refused to activate the target. The driver unlocked activation with a key press sent to the human's window and could not confirm that the window read it, so the target kept the foreground after that action and every later one until the human pressed a key or a mouse button. It now unlocks with a mouse input that reaches no window. The bundled Windows runtime is built from source `0cd994cb` of the [alexshpunt/cua](https://github.com/alexshpunt/cua) fork.

## 0.2.0 — 2026-11-24

### Changed

- Native input goes to its window in the background by default: points, keys, text, drags, coordinate scrolls and timelines reach the target window without taking the human's focus, pointer or keyboard, so several agents can work on one desktop at once. `foreground: true` takes the focus for one action and hands it back afterwards. Where a window cannot take an action in the background (WPF and XAML pointer input, a key that opens a Win32 menu), the driver refuses before sending anything and the tool repeats the action in the foreground by itself; the result says so. Hover and key holds always use the foreground.
- After foreground input, the window where the human last pressed a key or a mouse button gets the foreground back. After foreground pointer input on XAML canvases, such as Paint's, the target keeps the foreground, because Windows gives no evidence that it read the input.
- The bundled Windows runtime is Cua Driver 0.52.0 with cua-spacesd 0.16.1, from source `9dd83311` of the [alexshpunt/cua](https://github.com/alexshpunt/cua) fork. Every installation, host cache, remote machine, isolated session and sandbox carries both; a missing or changed file refuses before the driver starts.
- Requires Pi Agent IDE 1.0 (`pi-agent-ide >=1.0.1 <2`).

### Added

- Agents on one desktop keep out of each other's windows. A window an agent opens is its own, and `computer_window` action `claim` takes any other window; `release` or the end of the session gives it back. Input into a window another agent holds, and moving or resizing it, is refused with `window_claimed` and the holding agent's name.
- Machines listed under `machines` in `~/.pi/agent/computer-use.json` are available from every project. A project machine with the same name replaces the global one.
- All agents on a machine share its one Windows Sandbox, which has a real mouse. The first `open_sandbox` starts it and later ones join it in a few seconds; each agent sees and acts only on the apps it started there. Clicks, drags, keys and launches take turns with the guest's mouse and keyboard, an open menu keeps its agent's turn for up to 15 s, and a result that waited says how long. The sandbox stops 10 minutes after its last agent leaves.
- Optional screen zones in the shared sandbox (`"sandbox": {"zones": true}` in `.pi/computer-use.json`): each agent works in its own zone of the guest screen, up to four agents, and a guest service keeps its windows, dialogs and menus inside the zone. A fifth agent gets the machine's main desktop instead.
- Isolated sessions and sandboxes show each agent's windows as live session tiles on the human's desktop layer, above the wallpaper and under all windows; Ctrl+Alt+Space raises them. Tiles fill the desktop in rows, keep their windows' shapes, and spill into layers that Ctrl+Alt+PageDown and Ctrl+Alt+PageUp switch. An agent whose Pi runs on another machine than the sandbox gets its tiles on the sandbox machine too.

### Fixed

- An isolated session opens in about 40 seconds instead of several minutes on WSL: runtime files on a Windows drive are hashed once by Windows instead of through the drive mount.
- Isolated sessions capture windows without a compositor instead of returning black frames; a capture that stays black fails with `capture_black_frame`.
- Pointer input that an isolated session acknowledges but may not deliver is reported as `unknown`, and a sequence stops at that step.
- A foreground click on a window of another process embedded in the target window succeeds, and the typing that follows goes to that window.
- A fresh checkout installs with plain `npm ci`.

## 0.1.5 — 2026-11-09

### Fixed

- Start browser workers from the installed package on Windows and WSL, including remote machines. The Windows TypeScript loader is installed automatically and reused from a local cache.
- Recognize Firefox Nightly windows when opening a browser.

## 0.1.4 — 2026-11-09

### Changed

- UIA actions work on elements of embedded browser pages, such as WebView2, whose provider runs in another process than the window. The action refuses without sending input if the element's process no longer matches the snapshot or the element is not inside the target window.
- The bundled Windows runtime is rebuilt for these controls (Cua Driver 0.38.0, source `db235b24`).
- pi-agent-ide is a regular dependency (`>=0.9.8 <1`), so Pi installs it with the extension and shares one copy with other extensions.

## 0.1.3 — 2026-11-02

### Computer Use settings

- Open `/computer-settings` to manage access mode, the triple-Escape stop, screenshot options and visual presentation. Choose global or trusted project settings; project overrides can inherit global values.
- Configure the physical triple-Escape stop globally or per project. It remains enabled by default; changing it requires restarting Pi and reconnecting machines.
- `/computer-images` and `/computer-visuals` have been replaced by `/computer-settings`. `/computer-mode safe|yolo` remains available for session access and resuming after an Escape stop.
- Fix resuming after an Escape stop when driver connections or late stop notifications race.

### Demo and documentation

- Add a GIMP painting demo and a gallery of runs from five models. Show the Sol run in the README and as the Pi Packages video preview.
- Refresh the project artwork and clarify Windows, WSL and potential future Linux and macOS support.

## 0.1.2 — 2026-11-01

### Action previews

- Activity cards show more detail for keyboard shortcuts, clicks, scrolling, dragging and input timelines.
- Previews avoid showing printable text when focus is unknown or in password fields. Typed-text visibility still follows `/computer-visuals` settings.

## 0.1.1 — 2026-11-01

### Computer input

- Native input runs without waiting for the human to stop using the keyboard or mouse. Actions that need the foreground bring their window forward automatically; element actions still use UI Automation in the background when possible.
- Press Escape three times on the physical keyboard to stop agent input on the shared desktop. Use `/computer-mode safe` or `/computer-mode yolo` in a stopped session to resume. Sandboxes and isolated sessions are unaffected.
- Agents sharing a desktop take turns for foreground actions, so their typing and pointer gestures do not interleave.
- The agent cursor shows the session name. An activity card can show typed text, controlled by `/computer-visuals`; text for fields identified as passwords is excluded. Cards stay visible between consecutive actions and fade after the last one.
- `computer_window` no longer exposes a separate `focus` action.

## 0.1.0 — 2026-10-31

### First release

- Use Pi to discover and control Windows apps, displays and browsers through accessibility trees, screenshots and targeted input. Browser pages also support Playwright-based inspection and actions.
- Work with Pi Agent IDE's shared Read, Search and Delete tools, or use the standalone Computer Use tools. Tool guidance loads on demand.
- Use Safe mode to limit this extension to windows it opened, or work on separate desktops with Windows Sandbox or isolated sessions. Safe mode is an extension policy, not an operating-system security boundary.
- Connect to configured Windows machines over SSH and use the packaged operating skill for observation, input and verification.
