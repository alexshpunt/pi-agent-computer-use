# Native UI resources and hints

See [the resource guide](computer-resources.md) for the current addresses, views and commands.

Browsers and other Windows apps use the same window Reads. A window overview returns `ui`, a bounded projection of CUA's native accessibility snapshot, and one PNG with short labels when placement is possible. This is not a DOM tree or a promise that every visible control has an accessibility node.

## Observe once, refine locally

Each element has a short `hint`, the exact native `element_token`, reported role/name/value, enabled/selected state, actions, depth and `parent_hint`. `name` comes from the native label, which may fall back to value or help text. Missing properties stay null or absent. An empty `actions` array is not proof that pixel input is impossible.

`bounds.native_screen` and `bounds.window_image` are different coordinate spaces. Only reported screenshot-local bounds address pixels in the returned image. No adapter conversion invents missing bounds. Tree and pixels are not atomic, and neither proves paint freshness.

Search or refine the same observation without another native UI walk or input. Duplicate names remain separate candidates; choose from actual context, not the first match.

- `search`: filter collected names/values and optional role; an optional hint limits the search to that node and its collected descendants.
- `scope`: a required hint selects that node and descendants. Optional query/role/limit narrow the returned nodes. It also returns a marked copy of the existing overview, not fresh pixels.
- `inspect`: one exact element, no image or input.
- `highlight`: one exact element marked on the existing overview. Badge placement still respects other collected controls.
- `crop`: fresh native padded JPEG detail from the element's proven screenshot bounds. This consumes the overview's input authority. Observe again before acting.

Only search/scope accept filters and limits. Local operations keep original aliases and observation identity. Lifetime and permissions are still checked. The adapter keeps at most three recent overview PNGs for local annotation; eviction leaves structured inspection available but scope/highlight ask for a new overview. Detail never uses these saved pixels.

## Partial results and native rereads

The native walk defaults to 200 nodes and depth15. Set `capture:{max_elements:1..2000,max_depth:1..50,hints:boolean}` for the next native overview. A reread replaces this window's aliases and tokens. Native `query` also rereads; it filters only after the bounded walk.

`complete`, `truncated`, `truncation_reason` and `native_total` preserve reported limits. `matches` counts local matches before the output limit; `projection_truncated` reports that limit. The Windows runtime currently reports incomplete collection even when no budget was hit. Absence is not proof that a control does not exist.

Structured Codemode results retain the full bounded resource. Plain tool text shows at most30 elements with128-character names/values and declares its projection. Use local search/scope instead of printing the full tree.

## Act through exact current hints

Store only the chosen compact hint and observation ID. A hint is an address within this window/observation, not persistent control identity. A new native overview, detail, input, close or reload can retire it. Never rebind an old hint by matching its label.

Use one target form: `hint`, native `element_token`, or window-local pixels. Reported disabled and outside-image targets refuse before input. Hints also address supported token-based text/value input and scrolling; they do not add new native APIs. CUA may invoke, toggle, select or expand through its click route. Read the actual receipt, then verify application state. Unsupported routes remain refusals; unknown delivery is never replayed automatically.

Safe/YOLO, bounded sequences, explicit foreground escalation and graceful native interruption keep their existing contracts. No DOM/CDP, browser grant, scroll-into-view or generic focus API is added.

## Labels and private comparison

Labels are placed outside small reported controls and avoid other labels. Each drawn label records its exact region and target in `agent_image.annotation`. Dense collisions, disabled elements, missing bounds and outside-image nodes have explicit `hint_display` values. Annotation keeps the native image dimensions and sends one image, not raw and marked copies together.

The private debug viewer's **UI hints** switch affects later captures only. A capture-level `hints` value overrides it for that capture. Stored raw/sent comparison uses exact returned PNG bytes, not a full-resolution original or another screenshot. Existing captures never change when the setting changes. Assets remain session-local and bounded; unavailable/evicted originals are reported honestly. Never publish private pixels or UI text.
