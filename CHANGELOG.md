# Changelog

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
