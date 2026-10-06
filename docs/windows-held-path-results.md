# Windows continuous brush paths

[LPT-422](https://linear.app/alexshpunt/issue/LPT-422) passed its new Paint picture acceptance. The agent used only production `computer_*` tools through Codemode, selected a 21px Brush and drew a smiling robot, sun, cloud and grass in 27 completed paths. No Line tool, shapes, image import or other drawing backend was used. Paint remains open and unsaved.

## Exact runtime

Public MIT fork: [alexshpunt/cua](https://github.com/alexshpunt/cua), [PR #2](https://github.com/alexshpunt/cua/pull/2).
Upstream base: `b0968e1b12834e485dda68789541a3cc57664a9f` (0.34.0).
Compiled fork source: `bba07a9c8ccba117c1057a3a0003e95d3693b2b3`.
Driver SHA-256: `1ff0625b34fdb2116ebf253455e7eea2b9221fc81450f180ec4dc0ddc26d7224`.

The [unchanged Windows build](https://github.com/alexshpunt/cua/actions/runs/37418890622) passed before native changes. The [qualified fork build](https://github.com/alexshpunt/cua/actions/runs/37424342851) passed 826 core, 277 Windows and two protocol tests; one Windows test was ignored. This is not a claim that every upstream desktop test ran.

The unsigned artifact includes the UIA/cursor companions and MIT/third-party notices. After Paint passed, the user-approved installer placed those exact bytes in a separate user-local version directory and the trusted local config selected it. Installed hashes match CI. Existing 0.33.2 and Qt remain untouched. No PATH, services, registry, autostart, signing trust or administrator permissions changed. Fresh setups still default to 0.33.2; see [selection and installation](standalone-poc.md#qualified-continuous-paths).

## Native and Pi checks

- A nine-point curved path produced one application down/up pair. Invalid requests produced no application down.
- Foreground loss stopped at 1/40 points with press/release receipts and released physical state.
- Owned EOF through the qualified receiver released within 820ms during a four-second path.
- Existing keys/chords/text, right/double clicks, token scrolling and three straight strokes passed: 36 calls, 22 records and 50 application events.
- The installed production adapter delivered a 25-point curve. Actual AbortSignal closed its owned EOF-aware transport; outcome stayed unknown, release took 204ms and the old observation could not replay. Its disposable source/profile were removed.
- Main checks passed 171 unit tests, typecheck and 11 real-Pi tests. Real-Pi fixtures prove schema, Codemode, whole-batch validation, exact forwarding and no replay, not native physical release.
- A maximal 32-path sequence exposed truncated JSON results. The regression failed before compact requested `via_points` counts and passed afterward. Actual native path points were not reduced.

The Paint final PNG was 500x267, 52164 bytes, SHA-256 `dc33b713229a14e0adad681f0168c80aea332097d01d7ae58ee480bacc4cf5ce`. The private viewer exported matching bytes. After the final extension reload, the permanent runtime read the same recognizable picture without new input. A read-only native detail JPEG showed its continuous curved contours at 500x601; SHA-256 `e460b0c6ba194c2e55068c689d6efec823f5bf97fafbcaea00a2f4c194b66e8b`. Live TUI captures (pane w3E9:p7, revisions 2640 and 2658) showed readable tool results; stock collapsed images are not an inline-image claim.

## Failures and limits

Default serial upstream MCP cannot read EOF while awaiting a path. A failed serial probe left the button down. Recovery used a completed CUA click on an owned target and closed only the disposable sources. That failure is not included in passing counts. The required existing receiver is selected with child-local `CUA_DRIVER_MCP_ENVELOPES=1` and checked for `ai.cua.driver.envelopes` version 1. Bare cancellation notifications remain ignored. A timeout alone or forcibly killing a process is not a release guarantee.

After the first Paint stroke, a later batch refused `input_busy` before its first stroke. Read-only Windows metadata reported a held button. The user said they were not holding it and noted a remote connection might have latched it; the cause remains unknown. One completed foreground CUA click on the observed toolbar released it. Later strokes and final checks showed released buttons. No uncertain stroke was replayed.

Paths require explicit foreground, move the real pointer, use one left-button hold and release within a single call. They do not expose cross-call holds, background drawing or another platform's capabilities. Partial delivery reports its completed point prefix; never replay it. The human observer does not invent a target region when the native drag receipt lacks geometry.

Final read-only cleanup found zero Driver/helper processes and released left/right/middle buttons. The final picture remains open. Private pixels, full application trees, events, session URLs and window refs were not published. [Redacted evidence](evidence/windows-held-paths/run.json) records the checks.
