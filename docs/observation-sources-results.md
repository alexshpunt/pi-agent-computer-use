# Primary-display and source results

LPT-376 adds a read-only primary-display route to `computer_observe` and common source metadata for display, desktop-window and owned-browser images. Native CUA still captures every image; desktop uses 0.32.0 and browser uses 0.33.1. No new tool, input route, image engine or IDE change was added.

## Verified behavior

- YOLO permits `computer_observe({display:"primary"})`. Safe refuses it before native capture. A mode change to Safe or cancellation during capture withholds the pixels. Tests also cover private native-error diagnostics after permission revocation.
- Exactly one `display` or `window_ref` is required. Window-only queries, secondary displays and display input are refused. Display results contain no window reference or action observation ID. Window failures do not fall back to the display.
- All three sources use the same frozen native image settings: Lanczos3, default maximum edge 500, scale 1. CUA may round below the cap. No second resize is applied.
- `source` names the Windows domain, session-local identity, image and semantic scopes, completion timestamp, returned/native geometry and supported operations. Unknown DPI, DPR, occlusion and paint freshness are not invented.

## Actual native and parent checks

The [redacted record](evidence/display-observation/run.json) contains geometry, settings, hashes and cleanup metadata only. **No desktop pixels or private window text are tracked.**

The opt-in native guard probe made three `get_desktop_state` calls. Cap500 returned 499×333; cap250 returned 250×167 from the native 3840×2560 display. Reported scale factor was 1.5. Safe before capture dispatched zero native calls; an in-flight revocation published zero pixels. Native returned bytes and PNG dimensions were checked. Probe mode changes were trusted fixture state, not human command evidence.

The reloaded main Pi read the authorized primary display through Codemode. Its 499×333 PNG carried a display-only source with no input capability. A newly opened single-tab blank Notepad returned 381×499 pixels with native window bounds and the same Windows-domain envelope. It remained empty and was closed using a freshly observed Close Tab token. An owned browser on a synthetic local page returned 500×357 pixels: its image scope was the native window while its semantic scope was the owned page.

The live preview check found that the old metadata filter discarded `source.image` geometry. A regression test reproduced the loss. The filter now keeps source geometry while still excluding image data. After another reload, the main display result and exported preview matched by SHA-256 and complete source metadata. Final provider/wire delivery remains unconfirmed.

Actual Herdr checks used pane `w3E9:p6`, revisions 1414 and 1462. Source metadata, control values and image indicators were readable. Stock collapsed results did not show inline pixels; actual tool images and the Windows Vision debug site were inspected separately. The site showed the native500/scale1 controls and retained image cards. It polls the trace, not a continuous display recording.

## Checks and cleanup

Final **65 unit tests, typecheck and six real-Pi integration contracts passed** after the preview fix. Contracts include Safe restoration, no mode-promotion argument, zero-dispatch denial, cancellation/revocation, source geometry and unchanged pixel delivery. The clean staged snapshot passed the same 65 unit tests, typecheck and six real-Pi contracts after a fresh dependency install. The native probe and main-Pi checks passed; `git diff --check` passed.

Read-only Windows checks confirmed Notepad69472 and browser55248/48704 were gone, Driver count0 and disposable profile entries0. The only PowerShell process was the cleanup query itself. Both extension runtimes were released. Only the owned fixture server1721115 was stopped; no application was saved or unrelated process killed. An initial terminal-attached cleanup query stalled; its own WSL wrapper was stopped and a piped encoded read-only query completed.

## Limits

Primary display only. No display input, display zoom, automatic cross-source targeting, secondary-monitor selection or OS sandbox. Native bounds and scale factors are reported only when CUA supplies them; DPI and DPR stay unknown. Successful capture does not prove current paint or visibility. Only the separately approved owned browser is raised before capture. Desktop reads do not focus windows. Private temporary pixels are removed after the metadata record is saved.
