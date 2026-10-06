# Windows key-hold results

[LPT-610](https://linear.app/alexshpunt/issue/LPT-610) adds `computer_act({action:"hold",keys,duration_ms,actions?})` through the existing six computer tools and Codemode. One call holds 1..8 unique keys for 1..10000ms, optionally performs 1..32 complete grounded left clicks/drags, then releases its keys. Straight and continuous curved paths work while Shift stays down. No state survives between calls.

## Qualified runtime

The public [CUA fork](https://github.com/alexshpunt/cua/tree/3b3305044b7b327310615aa99d3307948a63061c) builds on the already qualified Windows drawing base. [Windows CI](https://github.com/alexshpunt/cua/actions/runs/37449622352) passed 827 core, 283 Windows (one ignored), two protocol and four schema tests. The driver is version 0.34.0, SHA-256 `9786ace009b81fb2555f14f64b605ab20c3bfc309493398424be1183532df749`.

The reviewed `scripts/install-cua-key-hold.ps1` verifies all three executable hashes and keeps notices/build metadata. It installs into a separate user-local `cua-driver-0.34.0-keys-3b330504` directory, without overwriting old builds or changing PATH, services, registry, autostart, trust or permissions. This installation explicitly selects `runtime:"windows-key-holds"`; fresh installations still default to 0.33.2. Both 0.33.2 and the earlier mouse-path fork remain unchanged. See [setup](standalone-poc.md).

## Observed behavior

- Native qualification passed 19 calls, 35 records and 83 application events. W and W+Shift each requested 500ms; application intervals were 478.4ms and 495.5/498.5ms. Physical key checks confirmed release. Shift click, straight stroke and continuous curve completed 3/3, with Shift down throughout pointer input.
- Invalid/background/busy requests refused before input. Foreground loss and target close returned partial progress with release. Acknowledged transport EOF released in 164ms; AbortSignal followed by owned EOF released in 159ms. No uncertain input was replayed.
- Existing complete-input compatibility passed 36 calls, 22 records and 52 events. Continuous-path lifecycle passed 25 calls and 15 records.
- The installed production adapter passed ten calls and 15 records. A real Session AbortSignal returned unknown, closed the owned receiver in 198ms and left physical keys/buttons up. Reusing its consumed overview refused.
- Production tools after reload passed W/W+Shift and combined pointer work. A further new fixture checked Shift click, straight drag and curved drag as three separate 700ms commands with fresh overviews. Measured holds were 702/701/701ms. Three key-down/up pairs, two stroke-down/up pairs and Shift on every stroke move matched the visible selection and two green strokes.
- The final actual PNG was 466x500, 42412 bytes, SHA-256 `76f04972007591d805e8f3f816f584c6bd71fffdced419031b66c1729fe2c30d`. Pixels stay private.
- The first TUI check exposed release/timing hidden in collapsed JSON. A failing regression led to a plain native summary. After the second reload, actual Herdr pane w3E9:p7 revision 2847 showed requested 500ms, held 502ms and `keys_released=true` without expanding JSON. Stock collapsed images are not an inline-image claim.
- 195 unit tests, typecheck and 12 real-Pi tests passed. These tests verify parsing, grounding, full-request validation, runtime selection, exact forwarding and truthful no-replay behavior; native physical release needs the live checks above.

Final read-only checks found no pressed W/modifiers/mouse buttons and zero Driver/helper processes. All disposable sources and profiles were removed. The existing unsaved Paint picture and user browser were not edited or closed.

## Limits and failed checks

Holds use foreground native input, only after an observed background refusal. Requested pointer time must fit the hold, including 50ms per click. There is no OS auto-repeat or real-time scheduling promise.

The child-local `CUA_DRIVER_MCP_ENVELOPES=1` receiver must acknowledge version 1. Default serial MCP, bare cancellation notifications and forced termination do not establish cleanup. Windows cannot distinguish a human pressing the same key after injection; this is not input isolation. Refusal never releases an already-held user key. Partial delivery must not be replayed.

Three earlier CI attempts failed compilation/schema checks; they are not passing evidence. An initial native fixture discovery and an initial compatibility key witness failed with owned cleanup. Harness discovery and launch-restoration waits were corrected, then fresh disposable runs passed. One parent verification stopped after the successful Shift click changed its button label/width; no click was replayed. A new observation confirmed the unchanged drawing board before the two remaining strokes.

Ungrounded keyboard/compound hold receipts do not supply action bounds; the human mark truthfully reports unavailable instead of inventing a selection. Native delivery remains distinct from app success. [Redacted evidence](evidence/windows-key-holds/run.json) contains metadata only.
