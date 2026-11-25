# Computer

- Load the `computer_*` tools with `tool_search`, one group per query: `computer open window`, `computer wait browser`, `computer files clipboard record`, `computer click hover drag scroll`, `computer type press select timeline`, `computer view viewport`.
- The `/computer-*` commands belong to the user: when a refusal names one, ask the user to run it.
- In IDE mode, native discovery of a `computer_*` action or `ide_capability_computer` loads computer-address help into the shared tools. Use the loader for a resource-only workflow. The first associated Codemode call loads that help too; `searchTools`, `describeTool` and `describeNamespace` leave it unloaded.
- Ordinary file calls and a direct computer-address {read} do not activate schema help. A direct computer-address {read} still works and loads this guide.

## Addresses

- A machine starts on its first use. An address belongs to the machine or sandbox that issued it, and every call on it runs there; nothing falls back to this machine.
- Short forms are `computer:<machine>/<letter><number><tag>`: `w` window, `o` observation, `s` sequence, `a` app, `b` sandbox, `d` display. The tag changes every Pi run, so an address from an earlier run refuses.

## Look

- A sandbox address takes the same `/windows` and `/apps` searches as a machine. Discovery launches nothing.
- {search} an observation to filter its lines without a new capture.
- An overview is 1280 px on the long edge by default.
- `offset` and `limit` page an observation's stored text without capturing again.
- A UI walk cut by limits or time leaves missing elements unknown, not absent.
- OCR can be wrong. For small text, use a viewport or `capture:{"granularity":"image","maxLongEdge":3840}`.

## Input

- Input spends the window's native refs; its change list brings the new ones.
- On native windows, a ref or locator goes through UI Automation in the background, without the human's pointer or focus. Browser pages take refs and locators through Playwright, also without them.
- Act on every element through a ref or locator first: `computer_click`, `computer_select`, `computer_type` with a target, `computer_scroll` on an element. Use a point, keys or a drag only after three structured attempts on that element left the app unchanged, when the latest read has no element for the target, or for canvases, drawing and games.
- Remember for the rest of the session which apps react to structured input and which do not. In an app where structured input left the app unchanged, use points and keys from the start.
- Points, keys, text, drags, coordinate scrolls and timelines go to the target window in the background: the driver sends them to the window's handle, with modifiers held only in that window thread's key state, so the human's focus, pointer and keyboard stay as they are. An app can ignore such input without an error; when the change list shows no change, repeat the action once with `foreground: true`.
- `foreground: true` takes the focus for that one action as real input and hands it back afterwards. Where the driver knows a window cannot take an action in the background (WPF and XAML pointer input, Blender, a key that opens a Win32 menu), it refuses before sending anything and the tool repeats the action with the focus taken by itself; the result says so. A refusal for an elevated window stays a refusal.
- `computer_hover` always uses the real pointer. On Windows, automatic foreground return requires supported read evidence covering every inserted event; unconfirmed input prevents that return. `computer_hover` and foreground coordinate scrolling do not automatically restore focus or move the pointer back. `computer_select` and menus run through UI Automation.
- When a receipt reports unconfirmed input, observe the target before another action. Do not replay the input to obtain confirmation.
- Foreground input runs at once, even while the human uses the computer, and agents on the same desktop take turns for it. Background input into an agent's own window does not wait for other agents' foreground actions.
- `human_stop`: the human pressed Escape three times. Send no more input, tell the user what you were doing, and wait until they turn computer use on again.

Native locators run over the UI Automation tree:

- `getByRole` — UIA control types as ARIA roles: `Button` → `button`, `Edit` → `textbox`, `ListItem` → `listitem` and `option`.
- `getByText`, `getByLabel`, `getByTitle` — visible text, a control's label, UIA help text.
- `getByTestId` — UIA AutomationId.
- `.filter()`, `.nth()`, `.first()`, `.last()`, `.and()`, `.or()` and chaining work as in Playwright. CSS and XPath refuse.

## Waits and viewports

- After `computer_wait`, the last sample's refs are current.
- The change list after input on a viewport covers only the viewport.
- {read} of a viewport only looks: the window's latest observation and refs stay current.
- {delete} removes a viewport; it also goes away with its window.
- Maximize an app that resizes its own window before making viewports.

## Windows of other agents

- A window this session opens with `computer_open` is its own: other agents' input into it and changes to it are refused, with this session's name, until the session ends.
- Claim a window that another process opened, such as one the human started, with `computer_window` action `claim` before working in it; give it back with `release` when done.
- `window_claimed`: another agent holds the window, and the refusal names it. Nothing was sent. Work in another window, or wait until that agent releases it.

## Displays

- Pick a resolution with the display's aspect ratio: a 3840×2560 display has no 1920×1280, and 2160×1440 is its closest smaller mode.
- The human sees the new resolution too: tell the user it stays until the computer session closes. Earlier display and window observations stop working; {read} again.

## Browser pages

For a visual click on a page, {read} the browser window with `views: ["page-image"]`. It returns the page viewport without browser chrome, resized to at most 1280 pixels on the long edge. Use the returned id and a point from that PNG, measured from its top left:
```js
computer_click({ window, space: `frame:${id}`, x: 640, y: 400 })
```
Read a new image after a frame click, navigation, tab switch, scroll or resize. The click refuses if the frame is no longer current for that window or the point is outside the image. A frame id is not for locators, other tools, native window images or element crops. Regular page points still use viewport CSS pixels; for the browser toolbar use a window image and `space: "window"`.

- Keys go to the page, so browser shortcuts such as `alt+ArrowLeft` do not run there: use `computer_browser`, or `space: "window"`.
- A popup does not become the active tab by itself: `computer_browser` `switch_tab`.
- Downloads land in a temporary folder that closing the session deletes; copy what you need.
- Providers such as Google can reject an automated browser even with `profile: "agent"`.
- Closing the session detaches an attached browser and leaves it open.

`computer_open` at a window address attaches by one of these routes:

- debugging endpoint — a browser, Electron or CEF app started with `--remote-debugging-port=0` in `args`, or a WebView2 app with debugging on. Chrome and Edge need their own `--user-data-dir` for this; Edge also `--disable-sync`.
- remote debugging turned on at `chrome://inspect/#remote-debugging` or `edge://inspect/#remote-debugging` — the browser asks "Allow remote debugging?" and waits up to 2 minutes; the user, or the agent in another call, clicks Allow.
- Playwright Extension — installed by the user; attaching waits up to 2 minutes for "Allow & select".
- VS Code's integrated browser — through `/computer-setup vscode-bridge` and a full VS Code restart.

## Work apart from the human's desktop

- Windows Sandbox — its own focus, pointer, windows and clipboard; starts in 15–20 s, and the human's Windows session must be active. Networking is enabled. The guest has no Notepad.
- Windows runs one sandbox per machine, so every agent on the machine shares it. The first `open_sandbox` starts it; later ones join it in a few seconds. Each agent sees and acts only on the windows of processes it started there, and display reads, the clipboard and recording are refused. Input from different agents takes turns: each click, drag, key or launch holds the guest's mouse and keyboard for that one call. An agent that leaves a menu, mouse capture or a pressed button open keeps its turn until its next action, and its result says so; once 15 s have passed since that action and another agent waits, the guest presses Escape, releases buttons and keys, and passes the turn on. A result that waited for its turn says how long. Deleting the sandbox address leaves the sandbox and closes the apps that agent started; the sandbox stops 10 minutes after its last agent leaves. Each agent's windows show as [session tiles](session-tiles.md) on the desktop of the machine that runs the sandbox, also when Pi runs on another machine; agents work with overlapping windows, and the tiles let the human follow each one.
- Screen zones are off by default. With `"sandbox": {"zones": true}` in the project's `.pi/computer-use.json`, a sandbox that this agent starts gives each agent its own zone of the guest screen, at most four agents per sandbox; agents that join later follow the running sandbox, whatever their own setting. One agent gets the whole work area, two get the left and right halves, three or four get the quarters, in the order they joined. The `open_sandbox` result names the zone. A guest service keeps every top-level window of the agent's processes, and of their child processes, inside the zone: windows are moved in and shrunk to fit, a maximized window is restored and sized to the zone instead, and dialogs, message boxes, menus and drop-down lists are moved like any window. A window the human drags is placed when the drag ends; a window that cannot shrink below its minimum size sticks out of the zone. When agents join or leave, the zones are laid out again and every window moves with its zone. When an agent's zone moves, its next action sends nothing and says the new zone; Read the window again before acting. A zone that stays in place, such as the top-left quarter when a fourth agent joins, interrupts nothing. An agent whose connection to the guest drops, as when it cancels a wait for the input, keeps its zone for 10 s to reconnect. A click, drag or other pointer input whose screen point lies outside the agent's zone is refused. Windows that a process shared with other agents opens, such as Explorer windows, are not moved.
- With zones on, a fifth agent's `open_sandbox` gets the machine's main desktop instead: the result says that the sandbox is full and gives the machine's address, and the requested folders are not shared anywhere.
- The sandbox window gets its monitor's full work area as its restored size before it is minimized, so the guest screen is about as large as the host's screen.
- Sandbox runtime and control mappings are automatic and read-only; its private output mapping is writable. `sandbox.import` is read-only unless `writable` is true, and `sandbox.export` is writable. Without an explicit `guest` folder they appear under the agent's own `C:\pi\agents\<sandbox>\`. Windows Sandbox cannot remove a shared folder, so it stays mapped, and readable by the other agents, until the sandbox stops.
- Isolated session — invisible to the human; starts in about 40–70 s; several can run at once. MXC starts a Windows `utility` session, not an RDP session. Its desktop is fixed at 1024×768: MXC has no size setting and Windows exposes no display device to resize. `computer_open` cannot request another size. Read individual windows rather than a display. The session has no pointer device, so Windows accepts clicks and drags without delivering them to the app. Unconfirmed pointer input returns `unknown`; read the window before retrying, or use a keyboard shortcut or UI Automation action. Some apps are missing by name (start them by `path`), and no user folders are shared automatically. Its network policy allows ingress and egress.
- Both use temporary control channels. Sandbox requires a driver bearer token and mutual identity proof; MXC reverse channels mutually prove their roles before forwarding application bytes. Their foreground UI stayed off the human desktop in verified Windows checks. Neither is qualified as hostile-code containment or protection from a local administrator.
- Another machine acts only there: a `url` such as `127.0.0.1` means that machine. Its Windows session must be active, or screenshots come back white. Remote control uses the existing SSH connection and temporary loopback forwards.

## Files and recording

- Save app documents in the session folder of `computer_files`, not in the user's folders.
- An app with its own scripting can build content: `computer_files` `put` the script, `computer_open` the app with its path in `args`, then {read} the window.
- The clipboard is shared with the user's apps.
- A window `sequence` spends the window's refs: {read} it again before input. A `watch` keeps them.
- While a `watch` runs, each action's receipt names its frames, and `frames:last` shows the newest one.

## Receipts in Codemode

Every `computer_*` tool resolves to a receipt object, also when it refused or its outcome is unknown, so a script branches without try/catch:

- `outcome` — `delivered` (not proof the app responded), `refused` (nothing was sent), `unknown` (may have reached the target: {read} again, never replay), `observed` or `closed`.
- `effect` — `applied`, `not-applied` or `unknown`.
- `stage` — `validation` when the request was rejected before reaching the target, otherwise `target`.
- `window`, `viewport`, `observation`, `sandbox` — the addresses the call used or issued.
- `reason`, `code` — why a refused or unknown action ended.
- `page`, `evaluation`, `verification`, `changes`, `steps`, `watch_spans` — when the action produced them.
- `text` — the receipt the model sees.

Check `outcome` before the next input: after a refused click, keys go to whatever has focus. A script that clicks many points uses a viewport: an action's change-list image can have another size than the last {read}. `store()` of a script that later fails is lost.

## Cleanup

Close only windows the task opened.
