# Computer resources through IDE tools

Load Pi Agent IDE and this extension together, in either order. Computer use owns the native backend; IDE owns the ordinary tool surfaces. Normal loading exposes no duplicate `computer_*` tools except `computer_classify`. The `/computer-mode` and `/computer-debug` commands remain user controls.

The current desktop scope is Windows controlled from WSL. A different interface does not qualify a new runtime or platform. Safe permits session-opened windows and forbids display reads. YOLO permits task-authorized existing windows; it is not OS isolation.

## Discover and read

Search `computer:apps` or `computer:windows` with a name/title query. Results include the available native process metadata and addressable app/window resources. Discovery launches nothing. Read `computer:displays` for connected-monitor metadata when the selected runtime supports it; display discovery takes no text predicate.

Insert into `computer:session` with `text` containing `{"action":"open","app":"Exact installed name"}` to open a genuinely new window. Alternatively, Insert `{"action":"open"}` into an app address returned by Search. Never replay an unknown launch.

Read a returned `computer:window/...` for its native accessibility structure and small overview PNG. Read `computer:display/primary`, or a returned display address, for readonly display pixels. Successful overviews issue `computer:observation/...` addresses. References are session-local and disappear on close/reload.

Read views:

| View | Meaning |
| --- | --- |
| `full` (default), `image`, `ui` | Fresh full window, pixels without a UI walk, or current UI without pixels. |
| `state` | Fresh native metadata without pixels or a UI walk. Use alone on a window. The selected runtime issues restore-only or management state; management also reports bounds, maximized state and independent virtual-desktop queries. |
| `dom`, `dom:{"locator":{"test_id":"save"}}` | Fresh bounded readonly DOM from an existing driver-owned browser. Use alone; see the DOM contract below. |
| `backend:default`, `backend:wgc` | Explicit window image route. WGC requires a qualified runtime, with no fallback. |
| `capture:{"max_elements":500,"max_depth":20,"hints":true}` | Fresh bounded walk/hints. Optional `guides` takes grid/region/action booleans. `maxLongEdge` (64..4096) and `scale` (0.05..1) set this window Read’s native image cap without changing session defaults. |
| `region:100,80,120,60` | Fresh readonly detail in local pixels of the addressed observation image. Consumes its overview. |
| `element:inspect,1:a` | Inspect an actual collected hint. Also scope/highlight/crop; crop consumes the overview. |
| `element:geometry,1:a` | Fresh readonly CSS geometry for a current main-document/open-shadow DOM hint. No native-pixel mapping or input authority. |
| `sequence:{"duration_ms":2000,"fps":4}` | Bounded temporal capture from a window or primary display. Returns metadata and a sequence address, not frames. |
| `frames:endpoints` | Explicit readonly selection from a sequence. Also all/first/last/changed, `frames:{"indexes":[0,2]}` or inclusive `frames:{"from":0,"to":2}`. |

Examples contain placeholder rectangles/hints. Choose actual targets from the current observation. `offset` and `limit` select text lines, never pixels or image-grid cells. Read a cached observation with `ui` to slice its collected text without another native walk. Acquisition options require a fresh window Read.

Search an observation address to filter its collected UI without another native walk. Missing nodes in an incomplete tree remain unknown. For native UI observations, scope and highlight use stored overview pixels; they are not fresh captures.

Detail retains the original local rectangle and native scale through movement/resizing, clips smaller bounds and never expands on growth. Detail from an ordinary WGC overview is unsupported: use an explicit default-route overview for that path. Qualified DOM detail uses the separate readonly transaction below. Display detail, frames and text selections never grant input authority.

## Readonly browser DOM

DOM inspection is opt-in through the explicitly selected, byte-checked `windows-dom-inspection` or `windows-dom-actions` runtime. It is not the default runtime. The route requires an existing driver-owned browser endpoint and an exact window with one proven selected tab. It never prepares an endpoint, launches or replaces a browser/profile, or activates a tab. Other windows and ordinary `ui`/`image`/`full` Reads keep their existing behavior and policy.

To explicitly create a new isolated browser, Insert `{"action":"open_browser"}` into `computer:session`. This uses the same selected runtime and native session as later DOM reads, returns its exact window address, and admits it under Safe. It accepts no URL, existing profile or endpoint. Opening is separate from inspection; a refused DOM read never launches a replacement. Never replay an uncertain launch.

Read the authorized window with `views:["dom"]`, or use one JSON view such as `dom:{"locator":{"role":"button","name":"Save"},"include_hidden":true,"max_nodes":100,"max_depth":16}`. Omit image, UI, state, backend and capture views. Locator fields are `role`, `name`, `label`, `text`, `test_id` and `css`. Semantic predicates are exact; `text` is a substring and `css` uses the native browser query. Combined predicates must all match; duplicate matches remain separate. Limits are `max_nodes` 1..200 and `max_depth` 1..32. Locators are bounded to 256 characters per field.

The returned `dom` resource contains snapshot-local hints, frame identities, tags, attributes, accessible role/name, live value/states and visibility where available. Native layout units are not qualified as CSS pixels: `bounds_css` stays null and `geometry_status` reports that limitation. Missing metadata stays unavailable. Check `complete`, `collection_complete`, `truncated`, `omitted` and projection limits before interpreting absence. A finished or empty projection does not prove that an incomplete collection inspected every node or frame.

Check `collection_scope` and `excluded` too. `author_dom_with_open_shadow` covers authored DOM and open shadow roots, not browser-generated user-agent shadow internals. `excluded.user_agent_shadow_roots` and `excluded.user_agent_shadow_hosts` report the excluded roots and fixed host counts separately. Authored closed or unknown shadow roots, missing children, unavailable frames and exhausted collection budgets still make coverage incomplete.

Read the issued observation without views, or with `dom`, to inspect its cached records. Search that observation to filter collected text and attributes without another native query. Read `element:inspect,<actual-hint>` for one record. Read `element:scope,<actual-hint>`, or a nonempty `dom:{...}` options view on the observation, for a fresh bounded native query; `scope` accepts only a hint from that observation. A refresh retires older hints. Fresh window reads, close and reload also retire them. Do not borrow hints between DOM/UI snapshots or frames; stale and detached native sources refuse rather than silently rebind.

Read the current DOM observation with `views:["element:geometry,<actual-hint>"]` for a fresh CSSOM geometry sample. This runs a fixed readonly function in an isolated world; it accepts no script. Main-document and open-shadow elements are supported; child-frame geometry refuses. Unknown or stale hints, detached or reused sources, Safe-mode revocation and cancellation refuse rather than rebind or fall back.

The returned `dom_geometry` identifies the window, source observation, hint, frame and provider receipt time (`received_at`, not a browser/paint timestamp). Its `bounds` use `coordinate_space:"frame_viewport_css_pixels"` with `viewport:"layout"`; `scroll` and `visual_viewport` are separate metadata. Treat the rectangle as a sample: `atomic:false` does not prove visibility or simultaneous DOM/paint state. `native_pixel_mapping:"unavailable"` means these values are not native image coordinates or input/crop/highlight authority.

Geometry sampling does not overwrite cached `bounds_css:null`, create a new DOM snapshot or renew reference lifetime. Cached Read, Search and `element:inspect` keep their existing behavior. Read the window with `dom` for fresh metadata and new hints.

DOM hints remain readonly: Write and ordinary input refuse, and cached reads/searches do not renew native references. A separate, explicit DOM action intent is described below. The reserved `document_css_pixels` domain never grants desktop or screenshot coordinates. Do not guess a transform or use a page screenshot as native pixels. Read a fresh native window overview for ordinary image/UI inspection or input.

### Qualified native DOM crop and highlight

Use `element:crop,<actual-hint>` or `element:highlight,<actual-hint>` on a current DOM observation for readonly native detail. This requires the exact byte-checked combined runtime selected by `windows-dom-inspection` or `windows-dom-actions`, plus the separate runtime/browser/revision/DPR policy in [the Driver](../src/driver.ts). The current raster scope is Chrome/155.0.8059.40 at DPR1.5 with that policy's exact Chromium revision. A matching version string alone is not enough. Other runtimes, browsers, revisions and DPRs refuse; selecting this profile does not adopt it as the installed default.

Use a main-document or open-shadow hint whose whole rectangle fits the qualified native viewport and capture. Child-frame mapping is not qualified. The provider checks two equal ready native geometry samples, captures a fresh WGC crop, then checks a third source/layout/native sample before returning any pixels. Changed, stale, detached, revoked, cancelled or unqualified sources withhold pixels without rebinding, replay or fallback. Read fresh DOM before deciding what to do after a refusal.

The crop is an unscaled, unpadded lossless PNG from original WGC pixels. Its reported capture-frame origin is not the window origin. Highlight adds a border to those validated crop pixels and may show the same proven physical region in the human-only overlay. Neither operation uses a saved overview, clips an unsupported rectangle, creates an input observation or grants nested-detail authority.

Keep the two geometry contracts separate. CSS `element:geometry` still reports `native_pixel_mapping:"unavailable"`; that sample grants no native crop authority. Native detail has its own source-bound geometry and explicit raster policy. It does not change cached `bounds_css:null` or renew DOM hints. Its native receipt still says `candidate_not_raster_qualified`; the provider's narrow raster policy is separate, not a promotion of that flag. Treat `atomic:false`, `input_authority:false` and `paint_freshness:"unverified"` literally: these checks do not prove simultaneous DOM/paint state, fresh compositor paint or input targeting.

## Locator-grounded DOM actions

DOM actions require the explicitly selected, byte-checked `windows-dom-actions` candidate. It is not the default runtime, and its Windows build and metadata checks do not establish live application acceptance. The readonly `windows-dom-inspection` profile does not provide locator input. A different tool interface, version string or DOM hint does not qualify it.

Read the authorized window with `dom`. Choose an actual main-document/open-shadow hint as document context, then Insert one explicit intent into that DOM observation address:

```json
{"action":"dom","source_hint":"<actual-hint>","input_route":"dom_event","request":{"action":"fill","locator":{"test_id":"name"},"text":"Ada","timeout_ms":5000}}
```

The source hint pins the inspected document, not the node to act on. The locator resolves the target within that same document. Omit native identities, coordinates, address query options, delivery, animation and sequences. Child-frame action sources refuse. Plain click/hint commands and literal Write do not become DOM actions.

| Request action | Required extra fields |
| --- | --- |
| `click`, `double_click`, `right_click`, `check`, `uncheck`, `focus`, `scroll_into_view` | None |
| `fill`, `type` | `text`, at most 2,000 characters; empty text is allowed |
| `press` | `key`, a supported explicit chord such as `Enter` or `Control+A` |
| `select_option` | `values`, 1..32 distinct exact option values |
| `hover` | `dwell_ms`, integer 1..10000 |

Use a nonempty locator with the same predicates as DOM Read. Each action accepts only its own extra fields. `timeout_ms` is an integer in 1..10000, default 5000, covering native readiness, serialization, dispatch and dwell. Readiness waits for the relevant visible/enabled/editable/stable/hit-test facts. Missing or unknown facts do not count as ready. Ambiguity, incomplete collection, document changes and stale sources refuse rather than choosing another target.

Choose `dom_event` explicitly for programmatic DOM semantics. It does not produce trusted input: hover events do not prove CSS `:hover`, synthetic keys do not perform browser defaults, and a context-menu event does not prove a native menu opened. `input_route:"trusted"` currently refuses without downgrade. No route uses caller-supplied JavaScript or silently falls back to coordinates or another backend.

Inspect `dom_action.progress`: attempted and acknowledged steps are separate, and `in_flight` identifies a step whose reply is unknown. `cleanup` reports only request-owned cleanup. Boolean `observed` samples describe acknowledged steps, not a fresh element snapshot or application success. A successful tool result means delivery completed, not that the application handled it. Application effects stay unknown/unverified even when every step is acknowledged. Cancellation can stop later steps but cannot undo a script already accepted by the browser.

A valid intent consumes the observation even when native dispatch refuses. Read fresh DOM after each action and verify the intended state. Never replay a completed or uncertain prefix. For an explicit native UI/image fallback, Read a fresh overview of the same authorized window; DOM/CSS coordinates never ground that input.

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

Close only task-owned disposable windows through grounded input first. Insert `{"action":"close"}` into `computer:session` to release the runtime and references. This does not close unrelated application documents or save them. It does end the session's explicitly opened isolated browsers and remove their owned profiles; a failed or uncertain cleanup is reported rather than called complete.

For a source checkout, run `npm ci --ignore-scripts --legacy-peer-deps`, then `npm run dev:ide -- /absolute/path/to/pi-agent-ide`. This links the public peer SDK without modifying IDE or its dependencies. Normal loading still needs both extensions installed. Use the [development skill](../.pi/skills/develop-computer-use/SKILL.md) for isolated task loading and restoration. Installation/interface switching and new native runtime adoption are separate decisions.
