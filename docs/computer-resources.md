# Computer resources through IDE tools

Load Pi Agent IDE and this extension together, in either order. Computer use owns the native backend; IDE owns the ordinary tool surfaces. Normal loading exposes no duplicate `computer_*` tools except `computer_classify`. The `/computer-mode` and `/computer-debug` commands remain user controls.

The current desktop scope is Windows controlled from WSL. A different interface does not qualify a new runtime or platform. The production `windows-desktop` profile selects the same checked bytes as `windows-window-management`, so it qualifies wherever this guide names that profile or one it inherits. Safe permits session-opened windows and forbids display reads. YOLO permits task-authorized existing windows; it is not OS isolation.

## Discover and read

Search `computer:apps` or `computer:windows` with a name/title query. Results include the available native process metadata and addressable app/window resources. Discovery launches nothing. Read `computer:displays` for connected-monitor metadata when the selected runtime supports it; display discovery takes no text predicate.

Insert into `computer:session` with `text` containing `{"action":"open","app":"Exact installed name"}` to open a genuinely new window. Alternatively, Insert `{"action":"open"}` into an app address returned by Search. Never replay an unknown launch.

Read a returned `computer:window/...` for its native accessibility structure and small overview PNG. Read `computer:display/primary`, or a returned display address, for readonly display pixels. Successful overviews issue `computer:observation/...` addresses. References are session-local and disappear on close/reload.

Read views:

| View | Meaning |
| --- | --- |
| `full` (default), `image`, `ui` | Fresh full window, pixels without a UI walk, or current UI without pixels. |
| `state` | Fresh native metadata without pixels or a UI walk. Use alone on a window. The selected runtime issues restore-only or management state; management also reports bounds, maximized state and independent virtual-desktop queries. |
| `dom`, `dom:{"target":{"role":"button","name":"Save"},"depth":4}` | Fresh Playwright aria snapshot of a browser opened with `open_browser`. Use alone; see [Browser pages](#browser-pages). |
| `backend:default`, `backend:wgc` | Explicit window image route. WGC requires a qualified runtime, with no fallback. |
| `capture:{"max_elements":500,"max_depth":20,"hints":true}` | Fresh bounded walk/hints. Optional `guides` takes grid/region/action booleans. `maxLongEdge` (64..4096) and `scale` (0.05..1) set this window Read’s native image cap without changing session defaults. |
| `region:100,80,120,60` | Fresh readonly detail in local pixels of the addressed observation image. Consumes its overview. |
| `element:inspect,1:a` | Inspect an actual collected UI hint. Also scope/highlight/crop; crop consumes the overview. On a DOM observation, `element:crop,<ref>` and `element:highlight,<ref>` return Playwright element images. |
| `sequence:{"duration_ms":2000,"fps":4}` | Bounded temporal capture from a window or primary display. Returns metadata and a sequence address, not frames. |
| `frames:endpoints` | Explicit readonly selection from a sequence. Also all/first/last/changed, `frames:{"indexes":[0,2]}` or inclusive `frames:{"from":0,"to":2}`. |

Examples contain placeholder rectangles/hints. Choose actual targets from the current observation. `offset` and `limit` select text lines, never pixels or image-grid cells. Read a cached observation with `ui` to slice its collected text without another native walk. Acquisition options require a fresh window Read.

Search an observation address to filter its collected UI without another native walk. Missing nodes in an incomplete tree remain unknown. For native UI observations, scope and highlight use stored overview pixels; they are not fresh captures.

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

Every action accepts `timeout_ms` (1..60000; default 5000, 30000 for navigation, `wait_load` and `new_tab`). Playwright waits for the element to be visible, stable, enabled and to receive events, then sends normal browser input. For example:

```json
{"action":"fill","target":{"label":"Name"},"text":"Ada"}
```

A delivered action returns the page's next snapshot as a new observation; check it for the application's response. A Playwright refusal, such as a strict-mode violation, sent nothing. A timeout or lost connection is `unknown`: the action may have reached the page, so read a fresh snapshot and never replay it blindly. Write, native input fields and address options do not apply to DOM observations.

On a DOM observation, Read `image` for a screenshot of the page viewport, `element:crop,<ref>` for one element, or `element:highlight,<ref>` for the viewport with that element overlaid. These are page pixels: they ground no native input. Search the observation to filter its snapshot lines. A fresh window Read of any kind replaces the window's previous observations.

### Tabs and dialogs

Every snapshot lists the browser's tabs (`Tab t1 (active): title | url | load state`, with `opened by` for popups) and `Event:` lines for tabs opened or closed and dialogs since the previous snapshot. Page actions, snapshots and screenshots use only the active tab. A popup or page-opened tab never becomes active by itself: Insert `switch_tab` to work in it. If the active tab closes, no tab is active until `switch_tab`. Tab ids stay valid for the browser's lifetime. Frames are reached through refs or `frames` locators in the active tab.

A JavaScript `alert`, `confirm` or `prompt` dialog stays open until you answer it. The snapshot shows a `Dialog:` line with its type, message and prompt default, and the tab list marks the tab. An action that opens a dialog returns as soon as the dialog appears; it may finish after you answer. Other page actions in that tab refuse without sending anything until you Insert `{"action":"dialog","accept":true}` or `false`.

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

Existing keyboard, pointer, semantic, drag, held-key and bounded-sequence capabilities retain their runtime gates and native limits. A sequence contains at most 32 known keyboard/stroke steps, up to 30 seconds of requested work and a 45-second elapsed admission budget. No cross-call held buttons/keys exist. See [complete input](complete-input.md), [strict semantics](semantic-actions.md) and [native pointer limits](research/native-hover-results.md) for backend contracts; their older standalone tool examples are historical.

Start with background. After an observed background refusal, Read a fresh overview before requesting explicit foreground delivery. Foreground may activate the window and disturb the real pointer. Delivery is not an application postcondition: Read again to verify the actual effect. Unsupported modes refuse rather than silently falling back.

Input consumes its observation even on refusal after admission. Interrupted batches retain their attempted/completed prefix. A later refusal does not erase prior input; the overall effect remains unknown. Never replay completed or uncertain steps. Cancellation stops future dispatch, but in-flight native input may still finish.

## Cleanup and development

Close only task-owned disposable windows through grounded input first. Insert `{"action":"close"}` into `computer:session` to release the runtime and references. This does not close unrelated application documents or save them. It does close the browsers this session opened and delete their profiles; a failed or uncertain cleanup is reported rather than called complete.

For a source checkout, run `npm ci --ignore-scripts --legacy-peer-deps`, then `npm run dev:ide -- /absolute/path/to/pi-agent-ide`. This links the public peer SDK without modifying IDE or its dependencies. Normal loading still needs both extensions installed. Use the [development skill](../.pi/skills/develop-computer-use/SKILL.md) for isolated task loading and restoration. Installation/interface switching and new native runtime adoption are separate decisions.
