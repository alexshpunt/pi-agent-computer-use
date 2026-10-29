# Native computer visuals

`/computer-visuals` controls human-only presentation on the machine that executes computer use. Native visuals require a driver advertising both `set_agent_visuals` and `present_agent_activity`. The adapter uses that driver's renderer and theme. It starts no viewer, HTTP listener or separate overlay process.

A driver without these capabilities keeps the legacy cursor behavior described in [complete input](complete-input.md). A version number alone does not enable native presentation.

## Human controls

Run `/computer-visuals` to show the current settings, or choose a preset:

- `off` disables presentation and discards pending previews.
- `subtle` keeps activity cues and disables previews by default.
- `full` enables previews by default.

A JSON patch controls individual categories and rendering preferences:

```text
/computer-visuals {"observations":true,"previews":false,"pointer":true,"scroll_drag":true,"keyboard":true,"opacity":0.8,"quality":"balanced","reduced_motion":false}
```

`opacity` is 0..1. `quality` is `performance`, `balanced` or `high`. Preferences are saved on the Pi session branch; navigating to another branch restores its preferences. These commands belong to the human. They do not change Safe/YOLO, capture sizing, input delivery or permission checks.

`/computer-images` controls future captures in this session: `cap 64..4096`, `scale 0.05..1`, `hints on|off`, `guides off|grid|action|all`, or `reset`. Calling it without arguments shows the settings. An individual Read can still override its capture options. Existing images keep their bytes.

## What a cue means

An overview identifies a captured window or display. A detail cue marks a requested physical region only when the adapter has a proven transform. Inspection and browser cues associate the operation with its native window; a Playwright CSS box does not establish a desktop rectangle. Element inspection uses native element bounds when available.

Action cues can report `delivered`, `refused` or `unknown`. `delivered` means input was sent, not that the application changed. Only a completed condition check can report `verified`. Quiet verification samples and background watch frames do not each create another cue.

Optional previews use a final PNG/JPEG returned by the operation, after cropping, resizing and annotation. A `changes` Read previews a returned change crop. A selected-frame batch admits at most its last returned image; a contact sheet or composite admits its final image. Capturing a sequence without returning images produces no preview. No extra capture or inference runs for presentation.

A preview does not establish that arbitrary Codemode forwarded that image or that a remote model received it. [Normal Pi image context](image-context.md) owns image retention and provider boundaries. Preview images are not archived or written to disk by presentation.

## Safety contract

Native presentation must be input-transparent, non-activating and protected from capture. It must not move the operating system cursor merely to animate. Input execution and visual playback have separate clocks: rendering and visual travel must not delay dispatch, while intentional typing, drag and system input timing stays intact.

Window events carry the existing HWND/PID lifetime identity and physical source bounds. The native renderer must revalidate them and hide stale drawings after movement, resize, minimize, closure or handle reuse. Selected displays use their exact native monitor bounds, including negative desktop origins. Ambiguous geometry never becomes a guessed rectangle or point.

The adapter admits one native request at a time and retains one replaceable pending activity. Pending activity expires after 250 ms; preview transport accepts only bounded PNG/JPEG payloads. Cancellation and mode changes revoke older generations. A cancellation of an old operation cannot clear a newer one. Capture companions disable their own presentation.

`highlight.status: queued` records adapter admission, not proof that a person saw pixels. An unavailable renderer does not repeat capture or input. Failed or cancelled startup releases the connection while keeping presentation preferences subscribed for a later attempt. Final session shutdown disposes those subscriptions. Backend refusal and capture exclusion still need qualification on the exact Windows runtime; the adapter alone cannot prove focus, transparency, screenshot exclusion or visual quality.

## Runtime qualification

Use the exact source and file hashes in [the runtime pins](bundled-runtime.md). Before shipping a native visual runtime, check a real Windows desktop for focus and hit testing, capture exclusion, source changes, multi-monitor geometry, concurrent sessions, reduced motion, cancellation and cleanup. Measure input latency independently of animation and bound idle/active resource use. Keep private desktop recordings in ignored local artifacts.
