# Windows source identity and action evidence

Window discovery rows, observations and native action receipts include `source_identity`. Captures also include the same fields in `source`, alongside image geometry and read/input scope.

- `domain: "windows-host"` names the current backend, not a sandbox.
- `identity.session_id` names this agent's ComputerSession. It is not a Windows login/session ID.
- `identity.window_ref` is this session's reference to a native window lifetime. PID/HWND describe the native target; models still address the window by its reference.
- `membership.windows_session_id`, `virtual_desktop_id` and `monitor_id` are null. The qualified native API does not return them. Negative coordinates, desktop position and the `primary` capture alias do not establish membership.
- Movement or resizing changes geometry, not lifetime. Closing/reusing a native handle retires the reference. Reload/close retires all session resources.

These fields describe an address. They do not grant input. Input still needs the latest authorized window overview. Display, detail and temporal pixels remain read-only. Foreign-session references or observations cannot authorize another agent's input.

## Read action receipts, not toolkit promises

A native action receipt includes `action_capability`. In a bounded input sequence, each attempted row in `state.sequence.steps` has its own projection. There is no batch-wide capability promise.

The projection applies only to that attempted action:

- `operation`, `native_tool` and `requested_delivery` identify the attempt.
- `actual_delivery` comes from native `delivery.mode`. Missing evidence stays `unknown`; requested mode does not fill the gap.
- `background` / `foreground` say `delivered` only for a delivered native result with explicit matching mode. Partial, uncertain or suspected-no-op input does not establish support.
- A native background refusal makes `background: "unavailable"`. Native foreground escalation makes `foreground: "suggested"`, not proven foreground-only support. Foreground may also fail.
- `unsupported: true` records a known held-path/key-hold runtime refusal. False means no such evidence, not guaranteed support.
- `route`, `event_kind` and `code` retain explicit native labels or null.

Pre-dispatch validation failures have no native action capability receipt. Neither native delivery nor this projection proves that the app handled the input or repainted. Observe again. Never cache one successful action as permission or support for the whole app, auto-promote to foreground, or replay an uncertain prefix.

## Native basis and limits

The qualified Windows fork is `3b3305044b7b327310615aa99d3307948a63061c`. Its public window state carries PID/HWND, screenshot/window bounds, snapshot tokens and UIA pattern names. It does not expose monitor, Windows session or Task View desktop membership. Its primary desktop capture alias does not name a physical monitor. Internal virtual-screen coordinate checks are not Windows virtual-desktop membership.

CUA's validated action result publishes route, effect and actual delivery. Background refusal publishes a code and optional foreground escalation. The adapter projects these fields without predicting capabilities from app names or UIA pattern labels.

This foundation does not add other-monitor capture, virtual-desktop management or concurrent input arbitration. Those remain separate parts of LPT-615. See [verification results](source-capabilities-results.md).
