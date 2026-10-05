# Human window frame

The Windows Qt helper draws a cyan frame around the whole window that the agent has just observed. A successful browser or desktop-window overview/detail starts a two-second flash. Another observation replaces it and restarts the timer. Display reads and display crops do not draw frames.

The frame is a human aid, not permission, model annotation, or evidence that the screenshot has current paint. CUA still owns capture and input. The helper cannot click, type, capture, activate a source window, or choose a target from a model argument. Browser capture still has its separately approved CUA foreground behavior.

## Identity and geometry

The adapter supplies its existing window lifetime marker and the successful capture's native bounds through a private pipe. The helper checks the HWND, PID and property marker. It matches the visible DWM bounds, not `GetWindowRect`'s invisible resize borders. It watches both rectangles and hides after a move, resize, minimize, close or lifetime change. It does not follow a stale window.

The helper refuses to show if foreground or keyboard focus changes during its show operation, or if Windows capture exclusion is unavailable. `WindowTransparentForInput`, no-activate styles and native hit testing make the frame input-transparent. These flags are not a substitute for the live input check.

Window coordinates remain in the CUA physical-pixel domain. Qt positions its own per-monitor-aware HWND with native physical coordinates; it does not turn image pixels into desktop input coordinates. Other DPI setups and Windows builds still need qualification.

## Lifecycle and failures

No helper starts at extension registration, a policy restore, an unused close, or a refused read. The first authorized window observation starts one owned process. Permission changes clear the frame, and cancellation cannot hide a newer observation's frame. Both runtime close tools and Pi shutdown close this helper through pipe EOF. Confirmed close permits a fresh helper later; unknown shutdown remains blocked until reload.

A missing or failed helper reports `highlight.status: unavailable` without changing image bytes or repeating capture/input. `shown` is an acknowledgement, not a promise that a person saw the short flash. The adapter rechecks cancellation and desktop permissions after the callback before publishing pixels. Native frame refusal hides the previous frame.

## Build and local deployment

Only Windows x64 is implemented and qualified here. Qt's cross-platform API does not establish macOS/Linux support.

Use the installed Qt 6.11.3 MSVC2022 x64 qtbase kit and existing Visual Studio 2022 Build Tools:

```powershell
powershell -NoProfile -File scripts/build-window-overlay.ps1 -QtPrefix <Qt-kit-directory>
```

The build stages sources into the user-local `PiComputerUsePoC/.tmp` directory to avoid MSBuild case-folding problems on WSL's case-sensitive share. Deployment contains the helper, `qt.conf`, Qt6Core, Qt6Gui, Qt6Widgets and `platforms/qwindows.dll`. There is no WebEngine, QML or Python runtime. This build relies on the host's existing MSVC redistributable, Windows ICU and system DLLs; it is not a clean-machine installer.

The package generator takes the built bundle, kit, exact Qt source checkout and a new output directory:

```sh
node scripts/package-window-overlay.mjs <bundle> <Qt-kit> <Qt-source> .tmp/qt-overlay/release
```

It verifies the exact SBOM's LGPL options, keeps license texts/attributions, supplies the complete matching qtbase source archive and helper source, and records hashes and separate runtime/source costs. See [the Qt notice](../native/window-overlay/NOTICE.md). Public binary redistribution requires its own licensing review; dynamic linking alone is not enough.

Install the runtime files in `%LOCALAPPDATA%/Programs/PiComputerUsePoC/window-overlay-0.1.0`, preserving the `platforms` and `licenses` directories. Keep the source sidecar available with the deployment. Discovery refuses ambiguous installations. `PI_WINDOW_OVERLAY_PATH` is an optional trusted executable override, not a model argument. Installation never runs at Pi startup.

## Verification

Unit contracts cover lazy startup, generations, cancellation, mode restoration, ownership, failure isolation and confirmed/unknown cleanup. The real-Pi browser contract checks unchanged PNG/JPEG delivery and frame acknowledgements without exposing private lifetime markers. Pipe tests verify EOF and malformed replies without request replay.

`node --experimental-transform-types scripts/verify-window-overlay.mjs` is an opt-in native probe on one owned synthetic browser. It checks bounds, focus, expiry, native capture exclusion and cleanup. Private full-display pixels remain ignored local artifacts, never Git or Linear uploads. `--show` is a separate human demo that repeats flashes until finished; it is not production timing or an automatic pass.
