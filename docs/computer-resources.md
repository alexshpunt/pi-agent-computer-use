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
- Drags, `computer_hover` and `computer_timeline` use real input. On Windows, automatic foreground return requires supported read evidence covering every inserted event; unconfirmed input prevents that return. `computer_hover` and coordinate scrolling do not automatically restore focus or move the pointer back. `computer_select` and menus run through UI Automation.
- When a receipt reports unconfirmed input, observe the target before another action. Do not replay the input to obtain confirmation.
- Real input runs at once, even while the human uses the computer. Another agent's action on the same desktop finishes first.
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

## Displays

- Pick a resolution with the display's aspect ratio: a 3840×2560 display has no 1920×1280, and 2160×1440 is its closest smaller mode.
- The human sees the new resolution too: tell the user it stays until the computer session closes. Earlier display and window observations stop working; {read} again.

## Browser pages

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
- Windows runs one sandbox per machine, so every agent on the machine shares it. The first `open_sandbox` starts it; later ones join it in a few seconds. Each agent sees and acts only on the windows of processes it started there, and display reads, the clipboard and recording are refused. Input from different agents takes turns: each click, drag, key or launch holds the guest's mouse and keyboard for that one call. An agent that leaves a menu, mouse capture or a pressed button open keeps its turn until its next action, and its result says so; once 15 s have passed since that action and another agent waits, the guest presses Escape, releases buttons and keys, and passes the turn on. A result that waited for its turn says how long. Deleting the sandbox address leaves the sandbox and closes the apps that agent started; the sandbox stops 10 minutes after its last agent leaves. When the sandbox runs on the machine Pi runs on, each agent's windows show as [session tiles](session-tiles.md) on the human's desktop.
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
