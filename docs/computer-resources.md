# Computer resources

Computer use reads and operates Windows app windows, displays and browser pages through `computer:` addresses. It works with or without Pi Agent IDE; each Pi session picks the mode on its own:

- With Pi Agent IDE, the ordinary Read, Search and Delete tools take `computer:` addresses.
- Without it, or with an IDE whose plugin API version does not match, `computer_read`, `computer_search` and `computer_delete` do the same. Read `docs:computer` with `computer_read` for this guide.

Everything else is a `computer_*` tool with typed fields, the same in both modes. Read only looks, Search only discovers, and the `computer_*` tools act. Write and Insert do not act on computer resources: they refuse and name the tool to use.

Every `computer_*` tool is deferred: a session that never uses the computer pays nothing for them. `tool_search` loads at most 8 best matches per query, so load one group at a time: `computer open window`, `computer wait browser`, `computer files clipboard record`, `computer click hover drag scroll`, `computer type press select timeline`. Computer use turns `tool_search` on.

The `/computer-mode`, `/computer-debug` and `/computer-setup` commands belong to the user. When a part is missing, the refusal names the `/computer-setup` command that installs it; ask the user to run it.

The desktop scope is Windows, with Pi running on it directly or in its WSL, on this machine or on another one over SSH. Safe permits windows the session opened and forbids display reads. YOLO also permits existing windows the task needs; it is not OS isolation.

## Tools

| Tool | Does |
| --- | --- |
| Read (`computer_read`) | Looks at a window, display, observation, sequence or machine: pixels, UI tree, page snapshot, OCR, window state |
| Search (`computer_search`) | Finds a machine's windows or installed apps, or filters the lines of an observation |
| Delete (`computer_delete`) | Closes a window like its close button, or releases a sandbox, isolated session, machine or `computer:session` |
| `computer_open` | Starts an app, a Playwright browser, a Windows Sandbox or an isolated session; attaches Playwright to a running browser window; sets WebView2 debugging for an app |
| `computer_window` | Moves, resizes, maximizes, minimizes, focuses or restores a window, or gives it a short name |
| `computer_display` | Changes a display's resolution |
| `computer_click`, `computer_hover`, `computer_drag`, `computer_scroll` | Pointer input on an element or a point |
| `computer_type`, `computer_press`, `computer_select`, `computer_timeline` | Text, keys and chords, list options, checkboxes and menus, timed raw events |
| `computer_wait` | Waits until a window's UI or page meets conditions, or checks them once |
| `computer_browser` | Navigates, manages tabs, answers dialogs, uploads, handles downloads and runs page JavaScript |
| `computer_files` | Copies files between the workspace and the session's folder on a machine |
| `computer_clipboard` | Reads or replaces a machine's clipboard |
| `computer_record` | Records a machine's display to video or its playback audio, or captures frames of a window or display over time |

Several steps in a row go into a Codemode script that calls these tools; each call returns a [receipt](#receipts-in-codemode).

## Addresses

| Address | Names |
| --- | --- |
| `computer:machine/local` | This machine |
| `computer:machine/<name>` | Another Windows machine configured under `machines` (see [Work on another machine](#work-on-another-machine)) |
| `computer:machine/<name>/windows`, `/apps` | Its windows and installed apps, for Search |
| `computer:machine/<name>/displays`, `/display/primary` | Its displays, for Read; listed displays are `/display/<ref>` |
| `computer:window/...` | A window, returned by Search or `computer_open` |
| `computer:observation/...` | One Read of a window or display, or a page snapshot |
| `computer:sequence/...` | Frames captured by `computer_record` `sequence` |
| `computer:app/...` | An installed app from Search; `computer_open` opens it |
| `computer:sandbox/...` | A Windows Sandbox or an isolated session |
| `computer:session` | Everything this computer use started |

A machine starts on its first use; nothing needs connecting. No address falls back to this machine: window, observation and sequence addresses belong to the machine or sandbox that issued them, and every call on them runs there. An address that no machine of this session issued, or that was released, refuses with the reason before anything is sent. Every receipt names its machine in its first line, for example `Computer observed (yolo) on lab`. Read `computer:session` for the machines, sandboxes, sessions, window names and windows so far.

Results show addresses in a short form, `computer:<machine>/<letter><number><tag>`: `computer:lab/w3qk` for a window, `o` for an observation, `s` for a sequence, `a` for an app, `b` for a sandbox and `d` for a listed display. The two-letter tag is drawn once per Pi run, so an address kept from an earlier run refuses instead of reaching whatever window got the same number. The long forms keep working and stay in structured details.

`computer_window` `name` gives a window a short address such as `computer:game`, usable wherever the window's address goes. A name is 1-32 lowercase letters, digits, `-` or `_`, starts with a letter, and is not an address word or machine name. One window has one name, and a live window's name is not taken over. A name refuses once its window has closed (a full window listing of its machine notices that) or its machine was released.

## Look: Read and Search

Search `computer:machine/<name>/windows` or `/apps` with a title substring or `regex:<pattern>`; sandbox addresses take the same queries. Discovery launches nothing. Search an observation to filter its UI or page lines without another walk.

Read a window for its UI tree and a small overview image. Overviews have a 1280 px long edge by default; add `capture:{"maxLongEdge":...}` to one Read for another size, and `/computer-debug` changes the session default. A fresh Read issues an observation address. Read a display for readonly display pixels (YOLO).

| View | Meaning |
| --- | --- |
| `full` (default), `image`, `ui` | A fresh window with pixels and UI, pixels only, or UI only |
| `aria` | A fresh UI-only Read as a [Playwright aria snapshot](https://playwright.dev/docs/aria-snapshots): `- button "Save" [ref=1:a]`, nested by the UI tree |
| `dom`, `dom:{"target":...,"depth":4,"boxes":true,"log":true}` | A fresh aria snapshot of the active page of a browser opened or attached with `computer_open`, with refs such as `e12` or `f1e3` in frames; `log` adds the retained console and network log. Use alone |
| `state` | The window's minimized, maximized, visible and foreground state and bounds, and whether its process is hung with its memory and CPU time; no pixels or UI. Use alone. `computer_window` changes the state |
| `changes` | A fresh Read that lists only rows changed (`~`), added (`+`) or removed (`-`) since the window's previous observation, and changed pixel areas with before/after crops. Use it when re-reading after a wait |
| `ocr` | Windows OCR of the overview pixels, lines with boxes in overview pixels. Alone or with capture options on a window, alone on an observation, or with `region:x,y,w,h` on one. Small text needs `capture:{"granularity":"image","maxLongEdge":3840}`. Recognised text can be wrong |
| `regions` | Icons and text areas found by [Cua perception](https://github.com/trycua/cua/releases/tag/cua-perception-v0.2.1) in the overview pixels, for controls without UI names such as canvas toolbars. Needs `/computer-setup perception` on that machine |
| `capture:{"max_elements":500,"max_depth":20,"hints":true,"maxLongEdge":...,"scale":...}` | Limits of one fresh Read; optional `guides` |
| `region:x,y,w,h` | Readonly detail of a rectangle in the observation's overview pixels |
| `element:inspect,1:a` | One element of an observation; also `scope`, `highlight`, `crop` and `text` (its full text). On a page snapshot, `element:crop,<ref>` and `element:highlight,<ref>` |
| `frames:endpoints` | Frames of a sequence: `first`, `last`, `all`, `changed`, `{"indexes":[0,2]}` or `{"from":0,"to":2}`; add `"as":"sheet"` for one tiled image, or `"max"`/`"min"` for a per-pixel composite ([temporal capture](temporal-capture.md#one-image-of-many-frames)) |

Read an observation with `offset` and `limit` to page through its text; pages come from the stored observation and never capture again. A browser snapshot keeps up to 400,000 characters, and `element:text` returns up to 200,000 characters of one native element. A partial UI walk leaves missing elements unknown. When a capture refuses and the window's process is hung, the refusal says so; wait or close the app.

## Act on windows

The input tools take a window address, never an observation. The window decides how input goes: a browser opened or attached by computer use runs it through Playwright on its active page, any other window through the native driver and UI Automation. A target is one of:

- **A ref** from the window's latest Read: a native ref such as `1:a` (from `full`, `ui` or `aria`), or a page ref such as `e12` from a `dom` Read. Input spends native refs; its change list brings the new ones.
- **A Playwright locator** such as `getByRole('button', { name: 'Save' })`, resolved with auto-waiting (`timeout_ms`, default 5000).
- **A point** (`x`, `y`). On a native window it is in pixels of the latest image of that window, from a Read with an image or from an action's change list; without one the tool captures the window first, about 300 ms once. On a browser page a point is in CSS pixels; `space: "window"` uses pixels of a window Read, for example for the browser's own toolbar.

Native input starts in the background, without moving the human's pointer or focus. When the window refuses background input before anything was sent, the same call sends it in the foreground and says so, and later input to that window goes in the foreground at once. `foreground: true` goes there first; `foreground: false` never does. A foreground action activates the window and moves the real pointer. `computer_hover` and `computer_timeline` move the real pointer on native windows, so they always run in the foreground.

While the human uses the keyboard or mouse, foreground input pauses: it refuses with the time since their last input and when to retry, until 10 s pass without it. Never try to outrun the human. When Windows refuses to activate the target (`foreground_unavailable`), the result names the process that holds the foreground; if it is a system service, for example after a UAC prompt, Windows blocks injected input until a person clicks or presses a key on that machine, so ask the user.

Keys on a browser page go to the page, so browser shortcuts such as `alt+ArrowLeft` do not run there; use `computer_browser` to go back, or `space: "window"` to press them natively. Pen eraser and barrel, the `x1`/`x2` buttons and `move_relative` exist only natively. Pen pressure and tilt reach apps as real pen input; on a page they arrive as a `pen` pointer in Chrome and Edge. Paint 11 ignores pen pressure; GIMP uses it.

A refused action sent nothing. An `unknown` outcome may have reached the target: Read again and never replay it blindly. Delivery is not proof of the application's response.

### Native locators

On native windows, Playwright's own parser reads the locator and this package evaluates it over the window's UI Automation tree with Playwright's semantics:

| Locator | Native meaning |
| --- | --- |
| `getByRole(role, { name, exact, checked, disabled, selected, expanded, pressed })` | ARIA role mapped from the UIA control type (`Button` → `button`, `Edit` → `textbox`, `ListItem` → `listitem` and `option`, `Text` → `text`, …); the UIA role name also matches. Names match a case-insensitive substring unless `exact` or a regex |
| `getByText`, `getByLabel`, `getByTitle` | The smallest element whose visible text matches; the name of labelled controls; the UIA help text |
| `getByTestId(id)` | UIA AutomationId |
| `.filter({ hasText, hasNotText, has, hasNot, visible })`, `.nth(i)`, `.first()`, `.last()`, `.and()`, `.or()`, chaining | As in Playwright; chaining searches inside the previous matches |

CSS and XPath refuse on native windows. Each action takes fresh UI walks until exactly one element matches and is ready: enabled, and for pointer input on screen and at the same place in two walks. Several matches refuse at once and list a locator for each; nothing is sent. Semantic actions, such as setting a value or choosing an option, also reach elements scrolled out of view. A walk that visited the whole UIA control view is complete, and then counts and absence are proven; a walk cut by limits or time leaves them unknown.

### What an action changed

Every action reports what it changed, the way Playwright MCP's incremental snapshots do: `~` changed, `+` added and `-` removed elements, plus URL, title or tab changes, such as `~ 3:a Button "Count 0" → "Count 1"`. Changed and added rows carry the new refs. A locator action compares with the walk that resolved its target; a page action compares Playwright's snapshots before and after.

On a native window, an action on an observation with pixels also compares the window's pixels and lists the changed areas in overview pixels, with before and after crops of the three largest:

```text
Pixels changed in 3 areas (overview pixels; 0.07% of the window):
  x=465 y=645 w=203 h=62; images 1 and 2 show x=453 y=633 w=227 h=86 before and after
```

This shows a stroke on a canvas or a moved sprite when the UI tree says nothing. Changes under 12 pixels and caret-shaped spots do not count. When the first capture shows no change, it looks again for up to 300 ms, then says `Nothing changed in the UI or the window's pixels within N ms`; check the target before repeating the action. When something changed, it captures until the window settles, for up to 1 second.

### Wait for conditions

`computer_wait` samples a window until every condition holds (`mode: "wait"`) or once (`mode: "check"`), without sending input. The last sample's refs are current for the next action.

| Check | Native windows | Browser pages |
| --- | --- | --- |
| `target` + `is` | `exists`, `absent`, `visible`, `hidden`, `enabled`, `disabled`, `selected`, `checked`, `unchecked`, `focused` | the same |
| `target` + `value` / `contains` | the element's value, or its name if it has none | a field's value, or an element's text |
| `target` + `count` | how many elements match, like `toHaveCount` | the same |
| `aria`, with or without `target` | the subtree contains this aria snapshot template, like `toMatchAriaSnapshot` | the target or the page body |
| `url_contains`, `title` | — | the active tab |

An `aria` template is Playwright's YAML, such as `- list "Pick":\n  - listitem "beta" [selected]` or `- button /Count \\d+/`. Each condition and the whole result are `satisfied`, `unsatisfied` or `unknown`: any `unsatisfied` decides, otherwise any `unknown` keeps the result unknown. Several matches are `unknown`; narrow the target. A held JavaScript dialog makes page conditions `unknown`.

### Windows and displays

`computer_window` samples the window's state and sends one command. Move and resize take integer Windows desktop pixels, not image, CSS or DIP coordinates, and need a normal window that is neither minimized nor maximized. Maximize and focus need the window on the current virtual desktop; nothing switches desktops. Focus does not restore a minimized window; `restore` does. The receipt reports the requested and measured bounds and the foreground separately from keyboard focus; Read again to see the new paint. These need the `windows-window-management` runtime (`windows-desktop` includes it); a runtime without it refuses, and keys or clicks are no substitute.

`computer_display` (YOLO) uses only modes the graphics driver lists; an unsupported size refuses and lists the supported ones. The change also affects what the human sees. Closing the computer session or the machine restores the replaced mode. Read displays and windows again afterwards: earlier display and window observations no longer work.

Delete of a window asks it to close: a browser the session opened closes with its disposable profile, an attached browser is detached first, and other windows get the standard close request. The receipt says whether the window closed; an app that asks about unsaved work stays open, so Read it next. Add `?force=true` to the window address to kill the hung app of a window this session opened. Safe closes only windows the session opened.

`computer_open` with `path` and `args` (YOLO) starts an executable by its absolute Windows path. Apps with their own scripting, such as Blender, can build content while computer use checks it: `computer_files` `put` the script, open the app with the returned path in `args`, then Read the window. Never replay an unknown launch.

## Browser pages

Web pages run through [Playwright](https://playwright.dev/). The browser window itself, its toolbar, system dialogs and every other application stay native windows. Playwright runs in a small worker on Windows, so browsers need Node.js there: an installed one, or `/computer-setup browser`. When Pi runs on Windows, the worker uses Pi's own Node.

`computer_open` with `browser` or `url` launches a visible browser with a disposable profile: Chrome by default, installed Edge, or Playwright's own Firefox (`/computer-setup firefox` once per machine and after updating this package; it cannot be attached to). `profile: "agent"` (YOLO) uses the agent's own persistent profile on that machine, so logins made there stay; it is never the user's profile, and one browser at a time uses it. Closing the computer session closes these browsers and deletes their disposable profiles.

Each page snapshot lists the tabs (`Tab t1 (active): title | url | load state`), `Event:` lines for opened or closed tabs and dialogs, `Download` lines and `Log` lines for console errors, page errors, failed requests and HTTP errors since the previous snapshot. Input, snapshots and screenshots use only the active tab; a popup never becomes active by itself, so use `computer_browser` `switch_tab`. A JavaScript dialog stays open until `computer_browser` `dialog` answers it, and other page actions refuse until then. Downloads land in the browser's temporary directory, which closing the session deletes; copy what you need. `evaluate` returns its result as JSON, cut at 20,000 characters; reaching the time limit is `unknown`. A Playwright timeout or lost connection is `unknown`; read a fresh snapshot.

### Attach to a running browser

In YOLO, `computer_open` at a window address attaches Playwright to a Chromium-based browser that is already running. The window's processes decide the route:

- **Debugging endpoint.** A browser, Electron or CEF app started with `--remote-debugging-port` (for example `args: ["--remote-debugging-port=0"]` in `computer_open`), or a WebView2 app with debugging on. Its pages are tabs. Chrome and Edge ignore that switch for their default profile, so such a browser runs with its own `--user-data-dir`; Edge also needs `--disable-sync`.
- **Remote debugging turned on in the running browser.** Chrome 144+ and Edge can allow it at `chrome://inspect/#remote-debugging` or `edge://inspect/#remote-debugging`, even with the default profile. The browser then asks "Allow remote debugging?" for each connection and waits up to 2 minutes; the user can click Allow, or the agent can click it in another call while the attach waits.
- **Playwright Extension.** Otherwise Microsoft's [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm), installed once by the user. Attaching opens its connect page and waits up to 2 minutes for "Allow & select"; approval exposes the whole browser, signed-in sessions included.
- **VS Code's integrated browser**, through the Pi Browser Bridge extension: `/computer-setup vscode-bridge`, then restart VS Code fully.

WebView2 apps take Chromium switches from their environment: `computer_open` with `path` and `debugging: true` starts one with debugging, and `webview2_debugging` turns it on for an app the user starts. That writes a per-exe WebView2 policy, so Windows shows a UAC prompt the person at that machine must approve; it applies from the app's next start until turned off.

The result names the route and the active tab. When the window title does not identify one tab, no tab is active until `switch_tab`. Closing the session detaches and leaves the browser open. Safe refuses attaching. Firefox cannot be attached.

## Work apart from the human's desktop

### Windows Sandbox

A sandbox is a separate disposable Windows environment with its own focus, pointer, windows and clipboard; it is not a security boundary against hostile code. `computer_open` with `sandbox` starts one on a machine in about 15–20 seconds and returns its `computer:sandbox/...` address. The host needs the Windows Sandbox feature, and the human's Windows session must be active. Windows runs one sandbox at a time, and its window stays minimized on the host: closing it stops the sandbox.

Search the sandbox address for guest windows and `computer_open` there to start a guest app; guest addresses work like host ones. The guest has no Notepad. Only explicit host folders are shared: `import` up to 8 folders, read-only unless `writable`, at `C:\pi\import\<name>` unless `guest` says otherwise, and one writable `export` folder at `C:\pi\export`. Clipboard, audio, video input and printers are never shared. Delete releases the sandbox.

### Isolated agent session

An isolated session, from [Microsoft Execution Containers](https://github.com/microsoft/mxc), is a separate Windows session for a fresh agent user on the same machine, with its own desktop, clipboard and input, invisible to the human. Several can run at once, and foreground input in one never reaches the human's desktop. `computer_open` with `isolated_session: true` starts one in about 15–25 seconds; it works like a sandbox address. Its desktop is 640×480 without a compositor, some apps are missing by name (start them by `path`), and no files are shared. It needs Windows 11 24H2 or 25H2 build 9550 or later and `/computer-setup mxc`. It is not a security boundary.

### Work on another machine

Another Windows machine with WSL can be operated over SSH: its windows, displays, browsers and sandboxes. Only machines named under `machines` in `.pi/computer-use.json` can be reached, by name, never by host or path. Its addresses work like local ones and never act on this machine; a browser `url` such as `127.0.0.1` means that machine. The remote user's Windows session must be active; a disconnected one returns white screenshots. Delete the machine address to stop its driver; its next use starts it again.

To set one up:

1. Make it reachable through an SSH alias that logs in to its WSL by key, with a known host key.
2. Run `/computer-setup machine <alias> [name]`. It copies the CUA runtime, a portable Windows Node and the browser worker into the remote user's folders and prints the `machines` entry. Run it again after updating this package.
3. Add the entry to `.pi/computer-use.json`:

```json
"machines": {
  "lab": {
    "ssh": "lab-wsl",
    "runtime": "windows-desktop",
    "command": "/mnt/c/Users/user/AppData/Local/Programs/PiComputerUse/cua-driver-0.37.0-f754b104/runtime/cua-driver.exe",
    "node": "/mnt/c/Users/user/AppData/Local/Programs/PiComputerUse/node-v22.22.2-win-x64/node.exe",
    "package": "/home/user/.local/share/pi-computer-use/package"
  }
}
```

All paths are on the remote WSL. Without `node` and `package`, the machine works without a browser.

## Files, clipboard and recording

Each computer session owns a folder in the machine's Windows temp directory. `computer_files` copies workspace files in (returning the Windows path for an app's Open dialog), copies files out and lists it. Names are plain file names in that folder; save app documents there rather than in the user's folders. Closing the session removes the folder.

`computer_clipboard` (YOLO) reads or replaces the clipboard, which is shared with the user's own apps and never read otherwise; paste with `computer_press` `ctrl+v`.

`computer_record` (YOLO) records the whole main display to H.264 video for up to 600 s (needs ffmpeg on that machine) or what its default playback device plays, with an optional transcript from [faster-whisper](https://github.com/SYSTRAN/faster-whisper); recognised speech can be wrong. Files land in the session folder, and `to` also copies them into the workspace. `sequence` captures frames of a window or display for up to 60 s, 30 FPS and 300 frames, and returns a sequence address; Read it with a `frames:` view. A window sequence spends the refs of the window's earlier Read, because the window may have changed while it was recorded: Read the window again before input.

## Receipts in Codemode

In Codemode every `computer_*` tool resolves to a receipt object, also when it refused or its outcome is unknown, so scripts branch without try/catch or text parsing:

```js
const r = await tools.computer_click({ window: "computer:game", target: "getByRole('button', { name: 'Save' })" });
if (r.outcome === "unknown") { /* read again; never replay */ }
else if (r.outcome === "refused") { /* nothing was sent */ }
```

| Field | Meaning |
| --- | --- |
| `outcome` | `delivered`, `refused`, `unknown`, `observed` or `closed`. `refused` sent nothing; `unknown` may have reached the target |
| `effect` | `applied`, `not-applied` or `unknown`; a refusal after an already delivered step stays `unknown` |
| `stage` | `validation` when the request was rejected before reaching the target, otherwise `target` |
| `window`, `observation`, `sandbox` | The window, the new current observation and a sandbox `computer_open` started |
| `application_effect` | Always `unverified`: delivery is not proof of the application's response |
| `reason`, `code` | Why a refused or unknown action ended |
| `page`, `evaluation`, `verification`, `changes`, `steps` | Present when the action produced them |
| `text` | The same receipt the model sees |

## Cleanup and development

Close only task-owned windows. Delete a machine address to release that machine, and `computer:session` to release every machine, browser, sandbox and isolated session this computer use started; Pi's shutdown does the same. This does not close or save the user's documents. The result lists each released part; an uncertain cleanup is `unknown`.

For a source checkout, run `npm ci --ignore-scripts --legacy-peer-deps`, then `npm run dev:ide -- /absolute/path/to/pi-agent-ide`. To try a worktree, point the package entry in your Pi settings at it, and point it back afterwards.
