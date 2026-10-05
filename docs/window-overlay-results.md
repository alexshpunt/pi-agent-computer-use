# Windows observation-frame results

LPT-408 is a Windows prototype, not a cross-platform Qt adoption decision. CUA 0.33.2 still owns capture and input. The Qt 6.11.3 helper only draws a cyan whole-window frame for two seconds after a successful observation.

## What passed

- Real Pi after reload: owned-browser open/overview/native JPEG detail and disposable Calculator open/overview returned `highlight.status: shown`. Browser → Calculator → browser reused one helper process. Calculator was closed through a fresh UIA reference, the browser and fixture were closed, and the helper was absent afterward. The shared ApplicationFrameHost process was not killed.
- Human check of the corrected native helper: the user confirmed the frame was visible and click/typing passed through. The synthetic page independently showed the click effect and a nonempty textbox. No scripted input was used for that check.
- Three installed-helper runs: foreground and keyboard focus unchanged by showing the frame, capture affinity 17, pixel-identical CUA desktop capture of the owned static window with the frame active versus hidden, disappearance after the two-second timeout, and no helper or source window after cleanup.
- 95 unit tests, typecheck and seven real-Pi integration contracts passed. These cover lazy startup, generation ordering, shared lifecycle, EOF/failure cleanup, cancellation, Safe denial, mode revocation, source identity guards and unchanged PNG/JPEG delivery.
- Actual TUI capture: Herdr `w3E9:p6`, revision 82. The compact `shown` result and geometry were readable. Stock tool rendering showed image placeholders, not inline image pixels; human on-screen visibility was verified separately.

[Redacted evidence](evidence/window-overlay/run.json) contains costs and output geometry/hashes, not private screen pixels or source text. [Usage and build](window-overlay.md) describes the local helper contract.

## The bug behind the missing frame

Strict geometry checks initially compared raw Win32 `GetWindowRect` with CUA's visible window bounds. Windows invisible resize borders made them differ by nine pixels on the tested Chrome window. The helper correctly refused to draw, so the frame was absent. It now compares `DWMWA_EXTENDED_FRAME_BOUNDS` and monitors both visible and outer geometry. CUA was not patched. Earlier refused, interrupted or unseen runs are not counted as passes.

## Measured cost

The installed release uses Qt Core, Gui, Widgets, `platforms/qwindows.dll` and local `qt.conf`; no QML, WebEngine, Python or Qt Network.

| Item | Actual logical bytes |
| --- | ---: |
| Helper executable | 40,960 |
| Binary runtime closure plus qt.conf | 27,481,339 |
| Runtime with notices/SBOM | 31,612,981 |
| Compressed runtime | 11,495,980 |
| Exact corresponding Qtbase source archive | 67,763,577 |
| Installed helper, sources and legal material | 99,399,798 |

Three repeated warm starts took 86, 98 and 203 ms (median 98 ms). Ready working set was 24.54–24.58 MB and private bytes 4.12–4.18 MB. Visible working set was 35.47–35.50 MB and private bytes 9.44–9.51 MB. The expired hidden window retained about 35.5 MB working set until process exit. These are single phase samples per run, not controlled cold-cache measurements, a memory-growth stress test or OS-independent RAM metrics. SDK storage is separate: the official archive was 39,643,659 bytes and its unpacked logical contents 278,389,095 bytes.

## Build and licensing boundary

The existing MSVC 19.44.35228 / Windows SDK 10.0.26100 built the helper. Qt was explicitly installed in the user's local PiComputerUsePoC directory, not into global PATH or a service. The final runtime is another user-local directory. No registry, admin or OS permission changes were made.

The package ships LGPLv3/GPLv3 texts, Qt and conservative third-party notices, SBOM, helper source/build material, replacement instructions and complete corresponding Qtbase source revision `5a1194b2d368e2d72c230205c464b04a2f23eccd`. Dynamic linking alone is not a compliance claim. Unmodified Qt DLLs can be replaced by compatible libraries; runtime loading has no replacement hash enforcement. Public distribution still needs license/signing/clean-machine review.

## Limits

Only this Windows/WSL host was qualified. No macOS/Linux, Wayland, crop/display-region frame, annotated agent image or multi-agent overlay claim. The host already had the required MSVC runtime and Windows libraries; this is not a clean-machine installer. WSL clangd lacks the Windows/Qt headers, while the actual MSVC Release build passed. Missing Qt or render failure reports unavailable/refused highlighting without replaying input or fabricating a screenshot. CUA browser foreground behavior remains separate and may change keyboard focus; it does not guarantee fresh paint.
