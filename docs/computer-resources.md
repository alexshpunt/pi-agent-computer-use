# Computer resources through IDE tools

Load Pi Agent IDE and this extension together, in either order. Computer use owns the native backend; IDE owns the ordinary tool surfaces. Normal loading exposes no duplicate `computer_*` tools except `computer_classify`. The `/computer-mode` and `/computer-debug` commands remain user controls.

The current desktop scope is Windows controlled from WSL, on this machine or on another one over SSH. A different interface does not qualify a new runtime or platform. The production `windows-desktop` profile selects the same checked bytes as `windows-window-management`, so it qualifies wherever this guide names that profile or one it inherits. Safe permits session-opened windows and forbids display reads. YOLO permits task-authorized existing windows; it is not OS isolation.

## Discover and read

Search `computer:apps` or `computer:windows` with a name/title substring, or `regex:<pattern>` for a case-insensitive regular expression; machine and sandbox addresses take the same queries. Results include the available native process metadata and addressable app/window resources. Discovery launches nothing. Read `computer:displays` for connected-monitor metadata when the selected runtime supports it; display discovery takes no text predicate.

Overviews have a 1280 px long edge by default; smaller windows are not enlarged. Add `capture:{"maxLongEdge":...}` to one window Read for another size; `/computer-debug` changes the session default.

Insert into `computer:session` with `text` containing `{"action":"open","app":"Exact installed name"}` to open a genuinely new window. An app_id or a Win32 executable name such as `notepad` also works; a miss suggests close installed names. Alternatively, Insert `{"action":"open"}` into an app address returned by Search. Never replay an unknown launch.

Read a returned `computer:window/...` for its native accessibility structure and small overview PNG. Read `computer:display/primary`, or a returned display address, for readonly display pixels; add `capture:{"maxLongEdge":320}` for another size. Successful overviews issue `computer:observation/...` addresses. References are session-local and disappear on close/reload.

Read views:

| View | Meaning |
| --- | --- |
| `full` (default), `image`, `ui` | Fresh full window, pixels without a UI walk, or current UI without pixels. |
| `state` | Fresh native metadata without pixels or a UI walk. Use alone on a window. The selected runtime issues restore-only or management state; management also reports bounds, maximized state and independent virtual-desktop queries. It also reports the window's process: whether Windows considers the window hung, its memory and CPU time (`process`). |
| `dom`, `dom:{"target":{"role":"button","name":"Save"},"depth":4}` | Fresh Playwright aria snapshot of a browser opened with `open_browser`. Use alone; add `"log":true` for the retained console and network log. See [Browser pages](#browser-pages). |
| `backend:default`, `backend:wgc` | Explicit window image route. WGC requires a qualified runtime. When WGC is only the runtime default and fails twice (it can, right after input or a launch), the overview uses the default route and says so; an explicit `backend:wgc` never falls back. |
| `capture:{"max_elements":500,"max_depth":20,"hints":true}` | Fresh bounded walk/hints. Optional `guides` takes grid/region/action booleans. `maxLongEdge` (64..4096) and `scale` (0.05..1) set this window Read’s native image cap without changing session defaults. |
| `region:100,80,120,60` | Fresh readonly detail in local pixels of the addressed observation image. Consumes its overview. |
| `ocr` | Windows OCR of the overview pixels, without UI hint labels. Alone or with capture options on a window, alone on its observation, or with `region:x,y,w,h` on an observation to read only that part (no native call; the observation stays usable). Lines and words come with boxes in the observation's overview pixels (`text_lines`). Small text needs a larger overview, for example `capture:{"granularity":"image","maxLongEdge":3840}`. Recognised text can be wrong: confirm with pixels or UI before acting on it. |
| `element:inspect,1:a` | Inspect an actual collected UI hint. Also scope/highlight/crop; crop consumes the overview. `element:text,<hint>` returns one native element's full text. On a DOM observation, `element:crop,<ref>` and `element:highlight,<ref>` return Playwright element images. |
| `sequence:{"duration_ms":2000,"fps":4}` | Bounded temporal capture from a window or primary display. Returns metadata and a sequence address, not frames. |
| `frames:endpoints` | Explicit readonly selection from a sequence. Also all/first/last/changed, `frames:{"indexes":[0,2]}` or inclusive `frames:{"from":0,"to":2}`. |

Examples contain placeholder rectangles/hints. Choose actual targets from the current observation. `offset` and `limit` select text lines, never pixels or image-grid cells. Read a cached observation with `ui` to slice its collected text without another native walk. Acquisition options require a fresh window Read.

Search an observation address to filter its collected UI without another native walk. Missing nodes in an incomplete tree remain unknown. For native UI observations, scope and highlight use stored overview pixels; they are not fresh captures.

When a capture refuses and the window's process is hung, the refusal says so with its memory; waiting or closing the app is the remedy, not another capture.

## Files on the controlled machine

Each computer session owns a folder in the controlled machine's Windows temp directory. Insert into `computer:session` (this machine) or `computer:machine/<name>`:

| Command | Effect |
| --- | --- |
| `{"action":"put","from":"art/in.png"}` | Copy a workspace file into the folder (optional `name`) and return its Windows path, for an app's Open dialog |
| `{"action":"get","name":"in.png","to":"art/out.png"}` | Copy a file from the folder into the workspace |
| `{"action":"files"}` | List the folder and its Windows path |

Names are plain file names inside that folder; nothing outside it is read or written there. Save app documents into this folder rather than the user's own folders. Closing the computer session removes the folder.

The same addresses take clipboard commands, in YOLO only, because the clipboard is shared with the user's own apps and is never read without one of these calls:

| Command | Effect |
| --- | --- |
| `{"action":"clipboard_write","text":"..."}` | Replace the clipboard with text; paste with ctrl+v in the target window |
| `{"action":"clipboard_write","image":"art/in.png"}` | Replace it with a workspace image |
| `{"action":"clipboard_read"}` | Its formats and text; add `"image":true` to also get its image |

Detail retains the original local rectangle and native scale through movement/resizing, clips smaller bounds and never expands on growth. Detail from an ordinary WGC overview is unsupported: use an explicit default-route overview for that path. Display detail, frames and text selections never grant input authority.

## Browser pages

Web pages run through [Playwright](https://playwright.dev/). The browser window itself, its tabs and toolbar, system dialogs and every other application stay native Windows windows read and operated as above.

Insert `{"action":"open_browser"}` into `computer:session` to launch a new visible browser with a disposable profile. Optional `"browser":"msedge"` selects installed Edge instead of Chrome, and `"url"` opens an HTTP(S) page. The result returns the browser's window address, owned by this session under Safe. Personal browsers and profiles are never attached, and DOM reads refuse in other windows. Never replay an uncertain launch. Closing the computer session closes these browsers and deletes their profiles.

Read the browser window with `views:["dom"]` for a fresh [aria snapshot](https://playwright.dev/docs/aria-snapshots) of its current page: YAML lines with roles, names, states, values and `[ref=e12]` element references, including iframes (refs such as `f1e3`) and open shadow roots. Narrow it with one JSON view, `dom:{"target":<target>,"depth":4}`, or add `"boxes":true` for CSS viewport boxes. Each snapshot issues a `computer:observation/...` address.

A target is either `{"ref":"e12"}` from the latest snapshot, or locator fields that must all match: `role` (with optional `name`), `label`, `text`, `placeholder`, `test_id` and `css`, plus optional `exact` and `frames` (CSS selectors of nested iframes, outermost first). Playwright resolves the target when it is used. Several matches refuse with a strict-mode error rather than choosing one.

Insert one JSON action into the latest DOM observation:

| Action | Fields |
| --- | --- |
| `click` | `target`; optional `button` (`left`, `right`, `middle`) and `click_count` 1..3 |
| `hover`, `check`, `uncheck`, `focus` | `target` |
| `fill`, `type` | `target`, `text`. Fill replaces the value; type presses each key |
| `press` | `key` such as `Enter` or `Control+A`; optional `target` |
| `select` | `target`, `values` (option values or labels) |
| `scroll` | `delta_x` and/or `delta_y` in CSS pixels; optional `target` to scroll under |
| `wait` | `target`; optional `state` (`visible`, `hidden`, `attached`, `detached`) |
| `navigate` | `url` (HTTP(S)) |
| `back`, `forward`, `reload` | none |
| `wait_load` | optional `state`: `load` (default), `domcontentloaded` or `networkidle` |
| `new_tab` | optional `url`; the new tab becomes active |
| `switch_tab` | `tab`, an id such as `t2` from the tab list |
| `close_tab` | optional `tab`; defaults to the active tab. The last tab refuses: close the computer session instead |
| `dialog` | `accept` (`true` or `false`); optional `text` answers an accepted prompt |
| `upload` | `target`, `files` (1..32 absolute WSL or Windows paths); `chooser: true` clicks the target and fills the file chooser it opens |
| `wait_download` | optional `download` id; defaults to the latest |
| `cancel_download` | optional `download` id; defaults to the latest |
| `evaluate` | `expression` (JavaScript); optional `target` passed to a function expression |

Every action accepts `timeout_ms` (1..60000; default 5000, 30000 for navigation, `wait_load`, `new_tab`, `upload`, `wait_download` and `evaluate`). Playwright waits for the element to be visible, stable, enabled and to receive events, then sends normal browser input. For example:

```json
{"action":"fill","target":{"label":"Name"},"text":"Ada"}
```

A delivered action returns the page's next snapshot as a new observation; check it for the application's response. A Playwright refusal, such as a strict-mode violation, sent nothing. A timeout or lost connection is `unknown`: the action may have reached the page, so read a fresh snapshot and never replay it blindly. Write, native input fields and address options do not apply to DOM observations.

On a DOM observation, Read `image` for a screenshot of the page viewport, `element:crop,<ref>` for one element, or `element:highlight,<ref>` for the viewport with that element overlaid. These are page pixels: they ground no native input. Search the observation to filter its snapshot lines. A fresh window Read of any kind replaces the window's previous observations.

### Tabs and dialogs

Every snapshot lists the browser's tabs (`Tab t1 (active): title | url | load state`, with `opened by` for popups) and `Event:` lines for tabs opened or closed and dialogs since the previous snapshot. Page actions, snapshots and screenshots use only the active tab. A popup or page-opened tab never becomes active by itself: Insert `switch_tab` to work in it. If the active tab closes, no tab is active until `switch_tab`. Tab ids stay valid for the browser's lifetime. Frames are reached through refs or `frames` locators in the active tab.

A JavaScript `alert`, `confirm` or `prompt` dialog stays open until you answer it. The snapshot shows a `Dialog:` line with its type, message and prompt default, and the tab list marks the tab. An action that opens a dialog returns as soon as the dialog appears; it may finish after you answer. Other page actions in that tab refuse without sending anything until you Insert `{"action":"dialog","accept":true}` or `false`.

### Files

Insert `upload` with a file input as `target`, or with `"chooser":true` and the button that opens the page's file chooser; the chooser is intercepted, so no native file dialog appears. Files must exist; a missing path refuses. The page may process the files asynchronously, so its response can appear in a later snapshot.

A download started by a page action appears as `Download d1: name | state | tab | bytes | path`, with state `in_progress`, `completed`, `canceled` or `failed`. The path is a WSL path into the browser's temporary directory; copy the file elsewhere if you need it, because closing the session deletes it. `wait_download` waits up to `timeout_ms` (default 30000); an unfinished download stays `in_progress` with an event, not an error. `cancel_download` stops an in-progress download and refuses for a finished one.

### Page code and diagnostics

Insert `{"action":"evaluate","expression":"document.title"}` to run JavaScript in the active tab. If the expression yields a function, it is called with the `target` element, or with nothing: `{"action":"evaluate","target":{"role":"status"},"expression":"el => el.textContent"}`. Promises are awaited. The result returns as `Evaluation result:` JSON, cut at 20000 characters. An exception thrown by the code is the action's result, shown as `Evaluation error:`. A target that does not resolve refuses before any code runs. Reaching the time limit is `unknown`: the code may still be running.

Every snapshot shows `Log` lines for console errors, warnings and assertions, uncaught page errors (`page_error`), failed requests (`request_failed`) and HTTP responses of 400 or more (`http_error`) since the previous snapshot. Each line has a sequence number, time, tab and URL. Read `dom:{"log":true}` for the browser's whole retained log, including console log/info/debug; it keeps the latest 200 entries and reports how many older ones were dropped. Use these lines to tell an application failure from an action failure: a refused or `unknown` action is reported on the action itself, not in the log.

## Work in a Windows Sandbox

Use a sandbox when the work should not touch the human's desktop or another agent's windows: no shared focus, pointer, windows or clipboard. It is a separate disposable Windows environment, not a security boundary against hostile code. The host needs the Windows Sandbox feature and its `wsb` command, and the human's Windows session must be active, at the console or in an open Remote Desktop window.

Insert `{"action":"open_sandbox"}` into `computer:session`. It starts a new sandbox with its own CUA driver, which takes about 15–20 seconds, and returns its address: in Codemode `sandbox` is `computer:sandbox/<ref>`. The sandbox window stays minimized on the host without taking focus; do not close it, because that stops the sandbox.

| On the sandbox address | Effect |
| --- | --- |
| Search with a title query | Guest windows, as `computer:window/...` addresses |
| Insert `{"action":"open","app":"Command Prompt"}` | Start an app in the guest and return its window |
| Insert `{"action":"close"}` | Destroy the sandbox; its window and observation addresses expire |

Read, Write and Insert work on guest window and observation addresses as on host ones. Their sources report the `windows-sandbox` domain, and `computer:windows` and `computer:apps` list only host windows. The guest has no Notepad; use apps the sandbox ships with, or bring your own through a shared folder. Guest windows use the default capture route, and console windows may need `delivery=foreground`, which brings the window forward inside the guest only.

Only explicit host folders are shared. Add them to `open_sandbox`:

```json
{"action":"open_sandbox","import":["C:\\data\\inputs",{"host":"C:\\repo","guest":"D:\\repo","writable":true}],"export":"C:\\out"}
```

`import` lists up to 8 host folders, read-only unless `writable` is true; without `guest` they appear as `C:\pi\import\<folder name>`. `export` is one host folder the guest can write, at `C:\pi\export`. Host folders must exist on a Windows drive. Clipboard, audio, video input and printers are never shared.

A missing feature, folder or Windows-drive path refuses before anything starts. Closing the computer session or Pi destroys every sandbox it opened, and a cancelled `open_sandbox` stops the sandbox it was starting.

## Work on another machine

Another Windows machine with WSL can be operated from this one over SSH: its windows, displays, an owned browser and a sandbox on it. Only machines named under `machines` in `.pi/computer-use.json` can be reached; the agent passes a name, never a host or path, and an unknown name refuses before any SSH work.

Insert `{"action":"connect","machine":"zinpc"}` into `computer:session`. It starts that machine's CUA driver over SSH and returns its address: in Codemode `machine` is `computer:machine/<name>`. Connecting again reuses the open connection.

| On the machine address | Effect |
| --- | --- |
| Search with a title query | That machine's windows, as `computer:window/...` addresses |
| Read | That machine's displays, as `computer:display/...` addresses; Insert `resize` into one to change its resolution |
| Insert `{"action":"open","app":"notepad"}` | Start an app there and return its window |
| Insert `{"action":"open_browser"}` | Launch an owned browser there (optional `browser`, `url`), as `open_browser` does locally |
| Insert `{"action":"open_sandbox"}` | Start a Windows Sandbox on that machine (with `import`/`export` folders of that machine) |
| Insert `{"action":"disconnect"}` | Close its sandboxes and browsers and stop its driver; its addresses expire |

Read, Write and Insert work on its window, display and observation addresses as on local ones, and never act on this machine. Their sources report the `windows-remote` domain, and `computer:windows`, `computer:apps` and `computer:displays` list only this machine. The current Safe/YOLO mode applies there too. A `url` for a remote browser is opened on that machine, so `127.0.0.1` means that machine. The remote user's Windows session must be active, at the console or in an open Remote Desktop window; a disconnected session returns white screenshots.

Closing the computer session or Pi disconnects every machine, and a cancelled `connect` stops what it started. The helpers run as SSH children and exit when SSH ends; no ports are opened on either machine.

### Set up a machine

1. Make the machine reachable with an SSH alias from `~/.ssh/config` that logs in to its WSL by key, without a password prompt. Its host key must already be known.
2. Run `scripts/setup-remote-machine.sh <alias> <local runtime folder> [name]` from this repository after `npm ci`. It copies the CUA runtime and checks its hash, installs a checksum-verified portable Windows Node in the remote user's folder, copies the browser worker, and prints the `machines` entry. It changes nothing system-wide.
3. Add that entry to `machines` in `.pi/computer-use.json`:

```json
"machines": {
  "zinpc": {
    "ssh": "zinpc-benchmark",
    "runtime": "windows-desktop",
    "command": "/mnt/c/Users/user/AppData/Local/Programs/PiComputerUse/cua-driver-0.34.0-desktop-4379acbd/runtime/cua-driver.exe",
    "node": "/mnt/c/Users/user/AppData/Local/Programs/PiComputerUse/node-v22.22.2-win-x64/node.exe",
    "package": "/home/user/.local/share/pi-computer-use/package"
  }
}
```

All paths are on the remote WSL. Without `node` and `package`, the machine works without a browser. Run the script again after updating this package so the remote browser worker matches.

## Change a display's resolution

A high-resolution display at a large Windows scale gives small, dense overviews. In YOLO, Insert `{"action":"resize","width":2160,"height":1440}` into a display address returned by `computer:displays` or by a machine address. It works on this machine and on a connected one; Safe refuses.

Only modes the graphics driver lists are used, keeping the colour depth and preferring the current refresh rate. An unsupported size refuses and lists the supported ones; keep the display's aspect ratio to avoid stretching. The change also affects what the human sees on that display.

Windows does not save the change. Closing the computer session, or disconnecting the machine, restores the mode the session replaced; signing out also restores it. After a change, read the displays and windows again: earlier display addresses, display observations and window observations of that session no longer work.

## Restore a minimized window

If an authorized window is minimized, Read its window address with `views:["state"]`. This collects only fresh native state and returns a one-use `computer:window-state/...` address. Reading that issued address checks its existing lifetime and permissions; it does not sample new state or renew authority. A fresh window Read, temporal capture, close or reload retires older authority.

Insert `{"action":"restore"}` into that state address to explicitly restore and activate the exact minimized window. Do not add identity, delivery, hint, coordinate or sequence fields. The state address grants no literal Write, typing, pointer or capture authority. This operation requires the explicitly selected, byte-checked `windows-window-restore` or inherited `windows-window-management` runtime; otherwise ask for manual restoration. Never use keys or clicks to bypass that refusal.

The receipt separates the restore request, observed restoration, activation attempt, actual foreground and separately known or unknown keyboard focus. It does not prove fresh paint: Read a new window overview afterward. An asynchronous restore may outlive cancellation or change foreground before explicit activation. Retain partial/unknown prefixes and never replay them. The operation does not restore the prior foreground or pointer.

## Manage an exact window

Use the explicitly selected, byte-checked `windows-window-management` runtime. Read the authorized window with `views:["state"]` to obtain its bounds, bounds source, minimized/maximized state, foreground, separately measured keyboard focus and independent virtual-desktop query results. This metadata issues one-use control state, not application-input or pixel authority. Cached Read does not resample or renew it.

Insert one command into the returned `computer:window-state/...` address:

| Operation | JSON command |
| --- | --- |
| Move | `{"action":"move","x":100,"y":80,"unit":"windows_desktop_pixels"}` |
| Resize | `{"action":"resize","width":640,"height":800,"unit":"windows_desktop_pixels"}` |
| Minimize / maximize / focus | `{"action":"minimize"}`, `{"action":"maximize"}` or `{"action":"focus"}` |
| Restore a minimized window | `{"action":"restore"}`, as above |

Choose frame values from the measured desktop geometry and the intended layout. Move changes only position; resize changes only dimensions. Values are integers: x/y in -100000..100000 and width/height in 1..32767. They use the reported native desktop-pixel rectangle, not local screenshot, CSS or DIP coordinates. The bounds source distinguishes DWM visible-frame bounds from GetWindowRect outer bounds; do not substitute one rectangle for the other.

Move and resize require a normal, non-minimized/non-maximized window and request no activation or z-order change. Minimize and maximize may change foreground through Windows itself. Focus activates without restoring a minimized window; use a fresh state and explicit restore for that case. Maximize and focus require confirmed membership on the current virtual desktop. Unknown membership refuses; no operation switches desktops implicitly.

Omit identity, hint, delivery, animation and sequence fields. A valid dispatch consumes state even on refusal. Read fresh state for another operation. The receipt retains attempted/accepted mutation, observed postcondition, requested/observed bounds and separate foreground/focus measurements. A constraint, cancellation, lost lifetime or incomplete readback stays unknown after possible submission. Never replay that prefix or simulate window controls with keys, clicks or pointer actions. Read a new overview to inspect paint after management.

## Input

Input uses the observation address returned by a fresh window overview, not a window address, PID or desktop position. A new overview retires the previous one. Resource resolution does not capture a newer screen or renew input authority.

Write `content` literally. Use an observed hint in the address, for example `computer:observation/<actual-id>?hint=<encoded-hint>&delivery=foreground&delay_ms=0`. Whitespace, quotes, newlines and JSON-looking text stay text. Write does not select all, submit, replace the whole field or execute a program. The native text limit is 2,000 characters; per-character delay is 0..200 ms.

Insert one JSON command in `text`, for example `{"action":"click","hint":"<actual-hint>"}` or `{"action":"hotkey","keys":["ctrl","a"]}`. Omit `window_ref` and `observation_id`; the address binds them. Choose one target form: hint/token or local overview-image pixels. Do not use image-detail, display, CSS or desktop coordinates.

For coordinate scroll, Insert `{"action":"scroll","x":<observed-x>,"y":<observed-y>,"delta_x":1,"delta_y":-2,"unit":"wheel_detents"}` into the current observation. Replace the point placeholders with local overview pixels inside the intended scroll surface. Deltas are signed integer wheel detents in -50..50; omit a zero axis, but provide at least one nonzero axis. Positive X means right and positive Y means down. One detent is 120 native wheel units, not a promised distance in content pixels. The `windows-coordinate-scroll` and inherited `windows-window-restore` / `windows-window-management` profiles are explicitly selected and byte-checked; other runtimes refuse this form. Background refuses without motion. After that refusal, Read a fresh window overview before adding `"delivery_mode":"foreground"`. Foreground moves the real pointer and leaves the window active. The native receipt preserves pointer and Y-then-X axis prefixes; inspect an interrupted prefix without replay. Do not combine coordinate scroll with hints, accessibility scroll fields, modifiers, animation or sequences. Existing hint-based accessibility scroll is unchanged.

For input that needs exact timing, held buttons or keys across moves, wheel during a drag, raw motion for pointer-locked apps or a pen, Insert `{"action":"timeline","events":[...]}` with `delivery=foreground`. Each event has `at_ms` (non-decreasing, up to 120000) and a `type`: `key_down`/`key_up` (`key`), `button_down`/`button_up` (`button`: left, right, middle, x1, x2), `move` (`x`,`y` in overview pixels), `move_relative` (`dx`,`dy` raw mouse counts, not pixels), `wheel` (`dx`/`dy` detents) and `pen_down`/`pen_move`/`pen_up` (`x`,`y`, optional `pressure` 0..1, `tilt_x`/`tilt_y` degrees, `eraser`, `barrel`). Presses must be balanced: the whole program is checked before any input, and whatever is still held is released when the call ends, fails or the window loses the foreground. It needs a runtime with `input_timeline`; others refuse it.

For an app with a menu bar, Insert `{"action":"menu","path":["File","Save As..."]}` into the observation to invoke that item through accessibility, one level at a time. A missing, ambiguous or disabled label refuses; it never falls back to pixels.

To end an app this session opened that does not close normally (for example a hung one), Insert `{"action":"kill"}` into its window address. It force-closes the process and loses unsaved work, and refuses for windows the session did not open or for a process that also shows other windows.

Existing keyboard, pointer, semantic, drag, held-key and bounded-sequence capabilities retain their runtime gates and native limits. A sequence contains up to 2000 known keyboard, click and stroke steps, up to 15 minutes of requested work and a 30-minute elapsed budget; a long drawing program fits into one call. Cancelling a sequence lets the current step finish and release its keys and buttons, then stops; the receipt reports the completed prefix. No cross-call held buttons/keys exist. See [complete input](complete-input.md), [strict semantics](semantic-actions.md) and [native pointer limits](research/native-hover-results.md) for backend contracts; their older standalone tool examples are historical.

Start with background. After an observed background refusal, Read a fresh overview before requesting explicit foreground delivery. Foreground may activate the window and disturb the real pointer. Delivery is not an application postcondition: Read again to verify the actual effect. Unsupported modes refuse rather than silently falling back.

Input consumes its observation even on refusal after admission, with one exception: after delivered input that used only pixel coordinates and keys (no hints, tokens or semantic actions), the observation stays usable. Each later call first checks the window cheaply and refuses with the reason when it was resized, minimized or hidden; moving the window keeps window-local points valid. The observation's UI hints expire with the first input, so use pixel coordinates or Read again. This lets a canvas program send many calls without capturing the window each time. Interrupted batches retain their attempted/completed prefix. A later refusal does not erase prior input; the overall effect remains unknown. Never replay completed or uncertain steps. Cancellation stops future dispatch, but in-flight native input may still finish.

## Receipts in Codemode

In Codemode, every computer Write and Insert resolves to a receipt object, also when the action was refused or its outcome is unknown, so scripts branch without try/catch or text parsing:

```js
const r = await tools.insert({ path: obs, text: JSON.stringify({ action: "click", target: { role: "button", name: "Save" } }) });
if (r.outcome === "unknown") { /* read again; never replay */ }
else if (r.outcome === "refused") { /* nothing was sent */ }
else { /* r.observation is the current observation, if one was issued */ }
```

| Field | Meaning |
| --- | --- |
| `outcome` | `delivered`, `refused`, `unknown`, `observed` or `closed`. `refused` sent nothing; `unknown` may have reached the target |
| `effect` | `applied`, `not-applied` or `unknown`; a refusal after an already delivered step stays `unknown` |
| `stage` | `validation` when the request was rejected before reaching the browser, session or driver, otherwise `target` |
| `observation`, `window` | The new current observation (a DOM snapshot, successor or verification sample) and the window |
| `sandbox` | The `computer:sandbox/...` address an `open_sandbox` started |
| `machine` | The `computer:machine/...` address a `connect` opened or a `disconnect` closed |
| `input_consumed` | Whether the addressed observation or window state can no longer be used for input |
| `application_effect` | Always `unverified`: delivery is not proof of the application's response |
| `reason`, `code` | Why a refused or unknown action ended |
| `page`, `evaluation`, `verification`, `postcondition`, `changes`, `steps`, `stopped` | Present when the action produced them |
| `text` | The same receipt the model sees |

Files and other resources keep returning text.

## Verify and wait

Insert `{"action":"wait_for","conditions":[...],"timeout_ms":3000}` into a **window** address to wait until every condition holds, or `{"action":"verify","conditions":[...]}` for one sample. Nothing is sent to the window. Optional `interval_ms` (50..5000, default 250) sets the sample spacing and `stable` (1..10) how many consecutive samples must agree; `timeout_ms` is 0..60000 (default 5000). Up to 16 conditions; each has one check:

| Check | Native windows | Browser pages |
| --- | --- | --- |
| `target` + `is` | `exists`, `absent`, `enabled`, `disabled`, `selected` | also `visible`, `hidden`, `checked`, `unchecked`, `focused` |
| `target` + `value` / `contains` | the element's value, or name if it has none | a field's value, or an element's text |
| `url_contains`, `title` (no target) | — | the active tab |

Native targets match `role` and exact `name`, or `text` contained in name or value; browser pages take any Playwright target. Each condition reports `satisfied`, `unsatisfied` or `unknown`, and so does the whole result: any `unsatisfied` decides it, otherwise any `unknown` keeps it unknown. Several matching elements are `unknown`; narrow the target. A native element missing from a partial UI walk is `unknown`, because only a complete walk proves absence. A held JavaScript dialog makes browser conditions `unknown`. The last sample becomes the window's current observation, so the next action can use it directly.

## Follow an action

Add `"expect":{"conditions":[...],"timeout_ms":3000}` to an Insert action to wait for its postcondition, and/or `"successor":true` to get the state after it. The result names the successor observation (now current) and a compact change list from the action's input observation instead of a full snapshot: `~` changed, `+` added and `-` removed elements, plus URL, title or tab changes. An empty list means nothing visible changed yet. Read the successor observation for the full state. A native list from a partial walk may show walk limits rather than real removals.

The postcondition is `verified` when the conditions came true after the action, `preexisting` when they already held before it, `failed` when they did not hold in time, and `unknown` otherwise. An action whose own outcome is unknown never reports `verified`.

## Read long text in pages

Read an observation with `offset` and `limit` to page through its text. Each page ends with `[Lines A-B of N. Continue with offset=…]` or `End of this observation's text.` Pages come from the stored observation: they never capture again or renew input authority. A truncated preview says to continue this way. Read `element:text,<hint>` on a native observation for one element's full text from the same capture, up to 200,000 characters; the UI listing shows at most 1,024 characters per element. Browser snapshots keep up to 400,000 characters.

## Batches

Insert `{"action":"batch","steps":[...]}` into an observation to run up to 16 known steps in one call. The whole list is validated before anything is sent. A batch stops at the first step that is refused or unknown, or whose `wait_for`/`verify` condition does not hold, and later steps are not sent. The result lists each step's outcome and why it stopped; never replay completed or uncertain steps.

On a browser observation, steps are the DOM actions above plus `wait_for` and `verify`. On a native window, steps are `click`, `double_click`, `right_click`, `type_text`, `key`, `hotkey`, `scroll` and the semantic actions, plus `wait_for` and `verify`. Only the first native step may use a hint or pixels of the current observation; later steps name `"target":{"role":"Document"}` (role, exact name and/or contained text), which is resolved in a fresh UI walk right before the step. A target that does not match exactly one element refuses that step with nothing sent.

```json
{"action":"batch","steps":[
  {"action":"fill","target":{"label":"Name"},"text":"Ada"},
  {"action":"click","target":{"role":"button","name":"Save"}},
  {"action":"wait_for","conditions":[{"target":{"role":"status"},"value":"saved Ada"}],"timeout_ms":3000}
]}
```

## Cleanup and development

Close only task-owned disposable windows through grounded input first. Insert `{"action":"close"}` into `computer:session` to release the runtime and references. This does not close unrelated application documents or save them. It does close the browsers this session opened and delete their profiles, destroys its sandboxes and disconnects its machines; a failed or uncertain cleanup is reported rather than called complete.

For a source checkout, run `npm ci --ignore-scripts --legacy-peer-deps`, then `npm run dev:ide -- /absolute/path/to/pi-agent-ide`. This links the public peer SDK without modifying IDE or its dependencies. Normal loading still needs both extensions installed. Use the [development skill](../.pi/skills/develop-computer-use/SKILL.md) for isolated task loading and restoration. Installation/interface switching and new native runtime adoption are separate decisions.
