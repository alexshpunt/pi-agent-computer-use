# Browser profiler results

## Measured pass

On the qualified Windows/WSL CUA 0.33.2 runtime:

```sh
node --experimental-transform-types scripts/profile-browser.mjs 5
```

The pass took 194 seconds, including setup and verification. All 102 adapter samples passed their checks: 75 warmed samples, 25 setup observations, one cold open and one close. The native cursor, automatic foreground and Qt observation frame stayed enabled. The fixture, helper, owned browser/session and Driver were released; read-only process/profile checks passed. Pre-existing profiles were preserved. The paused Pi game was not used or acted on.

The exact redacted report is [run.json](evidence/browser-profile/run.json). The report's sample count is not an action-only count: setup observations are included and labelled separately.

## Main operation times

Milliseconds; warmed rows have five samples. With this small series, p95 is the maximum.

| Operation | Median | p95 |
| --- | ---: | ---: |
| Tabs | 614 | 717 |
| Focus + overview | 2614 | 3102 |
| Full overview | 2180 | 2442 |
| Image-only overview | 2199 | 2878 |
| Zoom | 1981 | 2361 |
| Hint click, no capture | 920 | 1284 |
| Hint click + image | 3290 | 3794 |
| Hint click + semantics/image | 2979 | 3639 |
| Fill, no capture | 1047 | 1167 |
| Hover, no capture | 993 | 1128 |
| Window-image point click | 1265 | 1369 |
| Zoom-image point click | 1223 | 1360 |
| Scroll, no capture | 909 | 1096 |
| Navigate, no capture | 651 | 803 |
| Navigate + semantics/image | 2709 | 3330 |

Cold open was 5959ms and close 549ms, one sample each. The image-only median being slightly higher than full overview in this pass is variation, not evidence that collecting semantics makes capture faster.

## Where zoom spent its time

Every warmed zoom had ten child calls:

| Child | Calls per zoom | Median combined time per zoom |
| --- | ---: | ---: |
| Native browser binding | 2 | 1412ms |
| Native window geometry listing | 2 | 467ms |
| Window lifetime checks | 3 | 6ms |
| Native bring-to-front | 1 | 9ms |
| Native zoom RPC | 1 | 39ms |
| Qt frame acknowledgement | 1 | 14ms |

These are separate component medians; do not sum them to reconstruct the median total. In the first zoom, ordered child intervals plus 1.1ms remaining adapter time exactly accounted for 1841.8ms. The raw report preserves each sample and its actual accounting.

**The observed delay is mostly repeated native binding/geometry RPCs, not the zoom RPC or the frame's two-second display duration.** This does not establish why those Driver RPCs are slow internally. Their measurements include IPC/transport and Driver processing. No checks were removed and no performance fix is claimed.

Cold open separately included 305ms in the first RPC with Driver/MCP startup, 713ms for identity-peer creation, and 135ms for first frame-helper use. Those combined call durations are not isolated process-startup measurements.

## Verification

- Final qualification after tightening the expected-refusal guard passed 24 focused contracts, typecheck and a fresh one-sample native pass with every cleanup check true. The five-sample timings above are kept as their own measured series, not combined with this later qualification.
- Controlled-clock contracts verify child interval accounting without double-counting and exclude effect verification from adapter timing.
- Failure contracts preserve unknown/refused results and failed verification, prohibit retry, exclude them from successful distributions and still attempt every cleanup resource. Even an expected refusal cannot become a successful sample.
- Synthetic server counters confirmed clicks, input, hover, scroll and navigation effects. Image, foreground and frame acknowledgements were checked. The ignored synthetic overview was visually inspected to confirm pixel clicks/zoom target the large page area rather than browser chrome. None of these checks promises atomic paint readiness.
- Report key allowlists, successful sample checks and timing accounting were inspected. No arguments, screenshots, page text, entered values, private URLs, native identities or window IDs occur in the report.
- Actual Herdr viewport `w3E9:p6` revisions 1674 and 1676 showed readable ordered-child console output and a compact replay of the report summary. The stock tool renderer collapses longer output; the complete table remains in stdout and JSON. No renderer or extension change was made.

An initial preflight attempted to inspect other Windows users' profile directories and failed before opening a browser. It was narrowed to the current Windows user's CUA profile directory. That preflight is not counted as a successful profiling pass.

Read [the command and timing boundary](browser-profile.md) before interpreting these numbers. Pi/Codemode/model/TUI time, fixture verification and report output are outside the adapter timer. This is one local diagnostic series, not a cross-machine latency promise.
