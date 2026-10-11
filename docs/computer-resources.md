# Computer resources through IDE tools

Load Pi Agent IDE and this extension together, in either order. Computer use owns the native backend; IDE owns the ordinary tool surfaces. Normal loading exposes no duplicate `computer_*` tools except `computer_classify`. The `/computer-mode` and `/computer-debug` commands remain user controls.

The current desktop scope is Windows controlled from WSL. A different interface does not qualify a new runtime or platform. Safe permits session-opened windows and forbids display reads. YOLO permits task-authorized existing windows; it is not OS isolation.

## Discover and read

Search `computer:apps` or `computer:windows` with a name/title query. Results include the available native process metadata and addressable app/window resources. Discovery launches nothing. Search `computer:displays` with an empty query for connected monitors when the selected runtime supports it.

Insert into `computer:session` with `text` containing `{"action":"open","app":"Exact installed name"}` to open a genuinely new window. Alternatively, Insert `{"action":"open"}` into an app address returned by Search. Never replay an unknown launch.

Read a returned `computer:window/...` for its native accessibility structure and small overview PNG. Read `computer:display/primary`, or a returned display address, for readonly display pixels. Successful overviews issue `computer:observation/...` addresses. References are session-local and disappear on close/reload.

Read views:

| View | Meaning |
| --- | --- |
| `full` (default), `image`, `ui` | Fresh full window, pixels without a UI walk, or current UI without pixels. |
| `backend:default`, `backend:wgc` | Explicit window image route. WGC requires a qualified runtime, with no fallback. |
| `capture:{"max_elements":500,"max_depth":20,"hints":true}` | Fresh bounded walk/hints. Optional `guides` takes grid/region/action booleans. `maxLongEdge` (64..4096) and `scale` (0.05..1) set this window Read’s native image cap without changing session defaults. |
| `region:100,80,120,60` | Fresh readonly detail in local pixels of the addressed observation image. Consumes its overview. |
| `element:inspect,1:a` | Inspect an actual collected hint. Also scope/highlight/crop; crop consumes the overview. |
| `sequence:{"duration_ms":2000,"fps":4}` | Bounded temporal capture from a window or primary display. Returns metadata and a sequence address, not frames. |
| `frames:endpoints` | Explicit readonly selection from a sequence. Also all/first/last/changed, `frames:{"indexes":[0,2]}` or inclusive `frames:{"from":0,"to":2}`. |

Examples contain placeholder rectangles/hints. Choose actual targets from the current observation. `offset` and `limit` select text lines, never pixels or image-grid cells. Read a cached observation with `ui` to slice its collected text without another native walk. Acquisition options require a fresh window Read.

Search an observation address to filter its collected UI without another native walk. Missing nodes in an incomplete tree remain unknown. Scope and highlight use stored overview pixels; they are not fresh captures.

Detail retains the original local rectangle and native scale through movement/resizing, clips smaller bounds and never expands on growth. Native WGC detail is unsupported: use an explicit default-route overview when detail is needed. Display detail, frames and text selections never grant input authority.

## Input

Input uses the observation address returned by a fresh window overview, not a window address, PID or desktop position. A new overview retires the previous one. Resource resolution does not capture a newer screen or renew input authority.

Write `content` literally. Use an observed hint in the address, for example `computer:observation/<actual-id>?hint=<encoded-hint>&delivery=foreground&delay_ms=0`. Whitespace, quotes, newlines and JSON-looking text stay text. Write does not select all, submit, replace the whole field or execute a program. The native text limit is 2,000 characters; per-character delay is 0..200 ms.

Insert one JSON command in `text`, for example `{"action":"click","hint":"<actual-hint>"}` or `{"action":"hotkey","keys":["ctrl","a"]}`. Omit `window_ref` and `observation_id`; the address binds them. Choose one target form: hint/token or local overview-image pixels. Do not use image-detail, display, CSS or desktop coordinates.

Existing keyboard, pointer, semantic, drag, held-key and bounded-sequence capabilities retain their runtime gates and native limits. A sequence contains at most 32 known keyboard/stroke steps, up to 30 seconds of requested work and a 45-second elapsed admission budget. No cross-call held buttons/keys exist. See [complete input](complete-input.md), [strict semantics](semantic-actions.md) and [native pointer limits](research/native-hover-results.md) for backend contracts; their older standalone tool examples are historical.

Start with background. After an observed background refusal, Read a fresh overview before requesting explicit foreground delivery. Foreground may activate the window and disturb the real pointer. Delivery is not an application postcondition: Read again to verify the actual effect. Unsupported modes refuse rather than silently falling back.

Input consumes its observation even on refusal after admission. Interrupted batches retain their attempted/completed prefix. A later refusal does not erase prior input; the overall effect remains unknown. Never replay completed or uncertain steps. Cancellation stops future dispatch, but in-flight native input may still finish.

## Cleanup and development

Close only task-owned disposable windows through grounded input first. Insert `{"action":"close"}` into `computer:session` to release the runtime and references. This does not close application documents or save them.

For a source checkout, run `npm ci --ignore-scripts --legacy-peer-deps`, then `npm run dev:ide -- /absolute/path/to/pi-agent-ide`. This links the public peer SDK without modifying IDE or its dependencies. Normal loading still needs both extensions installed. Use the [development skill](../.pi/skills/develop-computer-use/SKILL.md) for isolated task loading and restoration. Installation/interface switching and new native runtime adoption are separate decisions.
