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

One overview may admit one sequence of known-target `key`, `hotkey`, `type_text`, `select_all` or `drag` steps. The entire list is validated before any input. Every drag is a complete straight stroke with release at the end. There are no nested sequences, pointer clicks or scroll steps inside this batch.

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

## Receipts and stopping

`state.sequence` reports total, attempted, completed, elapsed_ms, stop_reason and ordered per-step records. Each record includes requested parameters (text length, not its contents), requested wait, native tool, dispatch/completion offsets and delivered/refused/unknown status.

These are adapter/native receipt times, not invented application-event timestamps or native path samples. `completed` means the native call returned delivered; verify the application with a fresh observation.

Refusal, unknown/partial outcome, cancellation, access revocation or target lifetime loss stops later steps. Completed steps are not rolled back. Never replay a completed prefix or uncertain in-flight step. Invalid preflight sends nothing and does not consume the overview. Once the first native call is dispatched, the overview is retired for external input, even if the sequence fails.

The native driver owns each gesture's normal key/button release. No separate key-down/up, button hold, application hover, arbitrary continuous path or global release-all is exposed. There is no claim of immediate in-flight cancellation cleanup.

See the [operating skill](../.pi/skills/computer-use/SKILL.md) and [native capability research](research/cua-input-capabilities.md).
