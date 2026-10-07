# Windows shell desktop membership

Window discovery and available native observations can expose a window's Task View desktop. This is read-only metadata, not a desktop-management API.

CUA samples the documented `IVirtualDesktopManager::GetWindowDesktopId` and `IsWindowOnCurrentVirtualDesktop` methods independently. Pi does not probe Windows itself, infer a desktop from screen position, or activate a window to answer the query.

## Read the evidence

For an addressed window, `source_identity.membership.virtual_desktop_id` contains the native GUID or null. The corresponding `source_identity.virtual_desktop` explains the result. Captures carry the same projection in `source`.

A valid native sample has:

- `status: "sampled"`.
- `desktop_id`: a nonzero GUID or null.
- `on_current_desktop`: true, false or null. False is a known result, not an error.
- Independent `desktop_id_error` and `on_current_desktop_error`: null on success, otherwise the native failure code and nullable signed HRESULT.
- `sampled_at_unix_ms`: when these queries finished. This is separate from pixel capture timing; it is not an atomic snapshot or a paint/readiness promise.

Each method contributes a value or an error, never both. One failure does not erase the other method's success. Missing metadata returns `status: "unknown", reason: "not_reported"`. Malformed records, including a zero GUID, return `reason: "invalid_native_metadata"`; Pi never substitutes the current desktop.

Action receipts do not run another membership query or reuse an old sample as fresh evidence. Their address can therefore have unknown membership even after a known discovery. Window detail uses the later permitted native discovery sample, not the zoom pixels' capture time.

## Permissions and identity

Safe exposes only session-opened windows. YOLO does not authorize unrelated windows. Apply the task's query filter before reading or forwarding metadata.

Membership is not part of window lifetime. Switching the active desktop can change `on_current_desktop`; moving a window can change its GUID without changing its `window_ref`. Closing/recreating a window retires the old reference. Reload and close retire all session resources.

The agent's `identity.session_id` is not a Windows login session. Windows session and monitor membership remain unknown for ordinary windows. A shell desktop GUID is neither sandbox isolation nor input authority. Input still requires the current authorized window overview.

## Inventory and limits

A set of GUIDs derived from returned windows is **window-derived and incomplete**. It cannot identify empty desktops, names, order or the total desktop count. No separate desktop enumeration tool is added.

Other Windows sessions, undocumented COM, registry inventory, desktop lifecycle and automatic switching/moving are outside this feature. Knowing membership does not prove hidden-window capture, cross-desktop input, background focus behavior or concurrent-agent safety.

The native candidate is tracked in [fork RFC #8](https://github.com/alexshpunt/cua/issues/8) and [draft PR #9](https://github.com/alexshpunt/cua/pull/9). The exact candidate passed Windows build, protocol and live two-desktop checks; see [results and limits](shell-desktop-membership-results.md). Runtime retention is an explicit owner choice, not an automatic update.
