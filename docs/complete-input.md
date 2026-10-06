# Complete window input

Use the existing `computer_act` with a current window overview. CUA remains the only input backend. A display capture or detail cannot ground input.

## Single actions

- `key`: complete press/release of a letter, digit, return/tab/escape/space/backspace/delete, arrow, home/end/pageup/pagedown or f1..f12. Optional `modifiers` are ctrl/shift/alt/win.
- `hotkey`: `keys:["ctrl","a"]`, unique modifiers followed by one key.
- `type_text`: literal text up to2000 characters; `delay_ms` is CUA's per-character delay, 0..200, default30.
- `set_value`: replace an observed element's value; requires its token.
- `select_all`: complete Ctrl+A.
- `click`, `right_click`, `double_click`: observed token or window-image x/y. Optional modifiers; click also accepts a left/right/middle button.
- `scroll`: observed element token, direction up/down/left/right, amount1..50, by line/page. Pixel scroll is refused before input: CUA0.33.2 does not correctly map points from resized screenshots.
- `drag`: from_x/from_y/to_x/to_y in the window PNG. Optional duration_ms0..10000 (default500), steps1..200 (default20), left/right/middle button and modifiers.

Physical letter keys follow the active OS keyboard layout. Use `type_text` for literal text; the adapter does not change the user's layout.

A relative drag endpoint is computed from the observed start: `to_x=from_x+dx`, `to_y=from_y+dy`. No global cursor or desktop offset is needed.

Background delivery is the default. Explicit foreground is allowed only after an observed failure/refusal on the authorized window. The adapter never retries or escalates automatically.

## Bounded sequences

One overview may admit one sequence of known-target `key`, `hotkey`, `type_text`, `select_all` or `drag` steps. The entire list is validated before any input. Every drag is a complete stroke with release at the end. Without `via`, it follows the existing straight route. There are no nested sequences, pointer clicks or scroll steps inside this batch.

Bounds:

- 1..32 steps;
- wait_ms0..5000 before each step, measured after the previous completes;
- at most30s requested waits, typing delays and drag durations together;
- no further dispatch after45s elapsed time, including admission work.

These bounds do not guarantee real-time timing. Native admission, transport, focus handling and OS scheduling add latency. A native call already in progress may finish after cancellation or exceed the remaining elapsed budget.

```js
// Save the actual window_ref/observation_id from a current overview first.
try {
  text(await tools.computer_act({window_ref:load("window"),observation_id:load("observation"),
    action:"sequence",sequence:[
      {action:"key",key:"a"},
      {action:"hotkey",keys:["shift","b"],wait_ms:100},
      {action:"type_text",text:"hello",delay_ms:30}
    ]}));
} finally {store("observation",null);store("target",null);}
```

For computed drawing, choose points inside an actual observed canvas region. Map each pair to one drag step. Connected segments still have separate press/release pairs: they are not a continuous curve or held polyline.

```js
// p/q/r must come from the actual window overview, not CSS or detail pixels.
const pairs = [[p,q],[q,r],[r,p]];
const sequence = pairs.map(([from,to]) => ({action:"drag",from_x:from.x,from_y:from.y,
  to_x:to.x,to_y:to.y,duration_ms:250,steps:10}));
try {
  text(await tools.computer_act({window_ref:load("window"),observation_id:load("observation"),action:"sequence",sequence}));
} finally {store("observation",null);}
```

## Continuous brush paths

With the qualified Windows fork explicitly selected, `drag` accepts `via`: 1..254 intermediate `{x,y}` points. The endpoints and every intermediate point use the same current window PNG. One call presses the left button, follows all points and releases it. Do not pass `steps`, modifiers, or right/middle button with `via`.

Background refuses before path input. Observe again after that refusal, then explicitly request foreground. It moves the real pointer; do not fight it during the stroke. The default installed driver refuses an entire batch containing `via` before its first step.

```js
// points must be chosen from the actual overview. Each is a local {x,y}.
try {
  text(await tools.computer_act({window_ref:load("window"),observation_id:load("observation"),
    action:"drag", delivery_mode:"foreground",
    from_x:points[0].x, from_y:points[0].y, via:points.slice(1,-1),
    to_x:points.at(-1).x, to_y:points.at(-1).y, duration_ms:800}));
} finally {store("observation",null);}
```

A partial path returns `unknown`, preserving native `delivery.delivered_count` and the press/release summary. These count point moves, not completed batch steps. Later steps stop. Never replay the whole stroke or its uncertain remainder. Check the app's actual pixels before choosing another action.

See [trusted runtime selection](standalone-poc.md#continuous-path-candidate).

## Bounded key holds

With a qualified Windows key-hold runtime selected, `hold` keeps 1..8 unique keys down for `duration_ms`1..10000. Ordinary keys use the same names as `key`; ctrl/shift/alt/win are also allowed on their own or with ordinary keys. Modifiers go down first. The action releases its keys in reverse order before returning success. It does not expose separate key-down/up tools or carry a hold between calls.

Optional `actions` contains 1..32 complete left pixel clicks or drags from the same overview. Each drag may be straight or use `via`. Do not pass element tokens, per-action modifiers, button choices, key steps or nested holds. All requested pointer durations, including 50ms per click, must fit the hold interval. All keys and points are checked before input. Hold cannot nest in `sequence`.

Start with background. After its native refusal, take a new overview and explicitly use foreground. The real keyboard and pointer are in use during the action; do not fight them. Existing held keys/modifiers or mouse buttons cause a preflight refusal, not a release-all.

```js
// Use actual IDs from a fresh overview and points from its window PNG.
// Foreground here follows an observed background refusal.
try {
  text(await tools.computer_act({window_ref:load("window"),observation_id:load("observation"),
    action:"hold",keys:["shift","w"],duration_ms:500,delivery_mode:"foreground"}));
} finally {store("observation",null);store("target",null);}
```

For Shift + brush, use `keys:["shift"]` and `actions:[{action:"drag",from_x:p.x,from_y:p.y,via:points,to_x:q.x,to_y:q.y,duration_ms:800}]` inside a hold of at least800ms. Points must come from the current overview. The native summary reports requested/measured time, inserted keys, completed pointer actions and press/release prefixes. Scheduling and input delivery add latency; timing is not real-time and OS auto-repeat is not promised.

Cancellation closes the owned EOF-aware transport. Target or foreground loss stops further work and attempts release of action-owned keys/buttons. Partial input returns `unknown`; never replay it or assume a missing release receipt means success. Forced process kill cannot guarantee cleanup. Older runtimes refuse holds before input.

## Receipts and stopping

`state.sequence` reports total, attempted, completed, elapsed_ms, stop_reason and ordered per-step records. Each record includes requested parameters (text length and via-point count, not text or a full point dump), requested wait, native tool, dispatch/completion offsets and delivered/refused/unknown status.

These are adapter/native receipt times, not invented application-event timestamps or native path samples. `completed` means the native call returned delivered; verify the application with a fresh observation.

Refusal, unknown/partial outcome, cancellation, access revocation or target lifetime loss stops later steps. Completed steps are not rolled back. Never replay a completed prefix or uncertain in-flight step. Invalid preflight sends nothing and does not consume the overview. Once the first native call is dispatched, the overview is retired for external input, even if the sequence fails.

The native driver owns each gesture's normal key/button release. No separate key-down/up, cross-call button hold, application hover or global release-all is exposed. Held paths use the qualified fork's EOF-aware receiver; adapter cancellation closes its owned transport and attempts native release. A crash or forced process kill cannot guarantee release. Never interpret a timeout as a completed stroke.

See the [operating skill](../.pi/skills/computer-use/SKILL.md) and [native capability research](research/cua-input-capabilities.md).
