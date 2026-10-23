# Window input across monitors

Use a window overview and its `window_ref` for input, even when the window is on another monitor. Coordinates are local to the returned window image. Do not add a display origin or multiply by Windows scale; CUA owns that mapping.

The trusted `windows-capture-drag` runtime profile binds both straight-drag endpoints to the native capture behind that overview. CUA checks the exact target and current native dimensions before input. It maps both endpoints once and consumes the capture once. The adapter forwards that binding without another coordinate transform.

A resized frame refuses with `capture_frame_mismatch`. Stop and observe again. Do not retry without the binding, replay a delivered prefix or silently promote background input to foreground. If an overview has no native capture, this profile refuses the entire drag batch before its first step.

The profile requires an explicit executable path, its exact pinned SHA256 and the expected CUA version. It retains selected-display reads, held paths and key holds from its qualified base. Older profiles cannot receive capture-bound drag arguments. Calls without this optional native binding keep their existing route.

This is straight window drag only. `via` paths, zoom, held-key pointer actions and display input do not gain this new binding. Display/detail images remain read-only. Safe ownership, window lifetime and revocation checks still apply. Movement alone is not a window lifetime change.

Native delivery and application success are separate. Keep the native route/refusal and verify the intended application changed. This profile does not certify focus isolation, virtual desktops or concurrent-agent arbitration. Monitor membership and DPI remain unknown without native evidence.

Runtime selection is an owner decision; there is no automatic update or install.
