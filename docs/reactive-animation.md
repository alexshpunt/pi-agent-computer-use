# Reactive cursor animation

Ordinary actions keep CUA's current cursor animation. A bounded reactive program can opt into a short glide for one `computer_act` call:

```js
// Use IDs and a hint from the latest authorized window overview.
try {
  const receipt = await tools.computer_act({
    window_ref: load("window"), observation_id: load("observation"),
    action: "click", hint: load("target"), animation: "reactive"
  });
  // Keep receipts private inside a loop; publish only a bounded final summary.
} finally {
  store("observation", null); store("target", null);
}
```

The adapter reads the current CUA glide, applies the configured reactive glide, checks native state, runs the original input command, then restores and checks the previous glide. Calls are serialized so an ordinary action cannot inherit another action's temporary profile. A sequence opts in once at the top level; each native step restores the ordinary profile before the next step.

## Local configuration

An optional trusted `.pi/reactive-animation.json` contains only:

```json
{"glide_duration_ms": 1}
```

The default is 1ms. The value must be an integer in 1..5000. Zero is rejected because CUA uses it for automatic timing, not instant motion. Extra settings, including click-delay settings, are rejected. Reload after changing this local file. No machine-wide setting or runtime pin changes.

This controls decorative cursor glide only. Native click press/release and post-click waits stay unchanged (35ms and 50ms on the inspected Windows Chromium path). A 1ms glide does **not** mean a 1ms click. Identity checks, native transport, profile switching, delivery and scheduling still take time.

The same option works on a configured machine and in a sandbox; their drivers use the configuration of the workspace that connects to them. It matters: by default CUA waits for the visible cursor to arrive at each new point before clicking. On ZinPC that made a click on a new spot take 650–930 ms, against about 160 ms with the 1 ms glide (LPT-702).

## Receipts and failures

Successful native receipts include `animation.profile`, `glide_duration_ms`, `previous_glide_duration_ms`, `restored:true` and `timing_ms` for apply, native call and restore. These are adapter wall-clock measurements, not physical-input or compositor timestamps. Include profile-switch overhead when judging reaction latency.

A setter receipt alone does not prove the render thread applied the state. The adapter checks it with at most six native state reads before input and after restoration. A mismatch yields for 5ms before the next read (at most five yields), so the native render thread can apply its queued command. This bounded state-check cost is not a change to native click pauses. Cancellation cleanup does not reuse the cancelled action signal. If restoration cannot be confirmed, the adapter blocks subsequent calls until close and fresh discovery. Input may already have happened: do not replay it.

Fresh observation, permissions, target identity and the normal background/foreground rules are unchanged. This option grants no input authority and adds no new backend. See [complete input](complete-input.md) and [bounded reaction loops](../.pi/skills/reactive-visual-classifier/SKILL.md).
