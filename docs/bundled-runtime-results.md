# Bundled runtime results

LPT-662 ships a driver with one private Computer Use installation. This is not a public release or a Linux/macOS GUI qualification.

## Candidate

- Adapter implementation: `9ee8b5b6ec7994992790ef414e627992f2d3b8e6`.
- Native source: `819fa500b8bc3ec7ff8e008dd5e97c79f21ee1a0`.
- Four native packages: `0.34.0-dev.819fa500b8bc`, private Verdaccio tag `dev`.
- Tested extension preview: `@alexshp/pi-agent-computer-use@0.0.0-dev.1791466404`.
- Windows x64, Linux x64, macOS x64 and macOS arm64 all belong to the same source set. Exact file pins live in `src/runtime-pins.json`.

## Native build and installation

[Run 37780689449](https://github.com/alexshpunt/cua/actions/runs/37780689449) passed all four native jobs and the complete-set gate. Each matching runner built the runtime and companions, packed notices and hashes, installed its npm archive in a clean directory, checked installed bytes, and repeated read-only MCP initialization/tool-schema checks from the installed path. Windows exposed 63 native tools, Linux 62 and each Mac 58. All reported CUA 0.34.0. Probes made zero input or capture calls.

Five package regression tests passed. Missing/duplicate targets, mixed sources, changed files and missing companions cannot promote a complete set. The adapter pin generator also requires installed-path evidence before writing pins.

Earlier runs were not hidden or promoted: Linux Git ownership checks blocked the first two candidates; an unchanged macOS arm64 AppKit test aborted in the second. The disposable CI checkout trust setting was fixed. Common contract/core suites run on every target, with native Windows owner tests on Windows. Linux/macOS desktop suites are outside this build/API-only boundary. The intermediate complete build did not yet have the installed-archive gate; only source `819fa500` is selected.

Artifacts remain unsigned development builds. macOS uses a 13 deployment target and matching macOS 26 runners, without developer signing/notarization. Linux has a glibc 2.31 floor, portal input support and no PipeWire ScreenCast. Required display/session/permission dependencies are listed in [usage](bundled-runtime.md).

## One ordinary Pi installation

The four native packages were published only to the existing loopback Verdaccio registry. The first Windows publication was rejected with HTTP 413 and registry readback confirmed it had not published. The owner then approved only `max_body_size: 64mb` and a restart of `pi-verdaccio.service`. Those changes were applied; loopback address and access rules stayed unchanged. All four packages then published successfully.

A disposable `PI_CODING_AGENT_DIR` and clean working directory used:

```sh
pi install npm:@alexshp/pi-agent-computer-use --no-approve
pi list --no-approve
node scripts/verify-bundled-install.mjs <agent-directory> <clean-cwd>
```

No driver path, Computer Use local config, separate CUA install or first-use download was supplied. npm installed the exact Windows and Linux optional dependencies on WSL. The checker verified every installed companion/notice hash and all four declared dependency versions. Ordinary Pi RPC startup automatically loaded the package's `computer-mode` and `computer-debug` commands with package-origin metadata, without `-e`, a model prompt or input/capture. The clean installation reported zero npm vulnerabilities.

The first disposable settings file used the wrong `npmCommand` type; correcting it to the documented string array resolved `spawn / EACCES`. A direct Node import of installed TypeScript also failed because Node does not strip types under `node_modules`; the checker uses actual Pi autoload instead. Neither failure is reported as a native runtime defect.

The WSL resolver selected the pinned Windows runtime automatically and copied its checked files into a source-specific Windows Local Application Data cache. It did not touch old `PiComputerUsePoC` runtime directories. A separate read-only startup checked the MCP catalog and refused a nonexistent native capability with `attempted:false`, without dispatch or fallback. There was no local command or environment driver override.

## Reloaded Windows/WSL production check

After reloading the extension, production `computer_*` tools used the default bundle through the project development wrapper. The clean npm install/autoload check above was separate; this was not a second global installation.

- App discovery identified Windows Notepad. Opening created a new native window with a lifetime-bound reference and a full window observation.
- Notepad restored two tabs from earlier tests. They were left unchanged. Testing used new disposable tabs only.
- An observed Add New Tab action created a blank tab. Background `type_text` returned delivered, but its immediate readback was empty and showed another blank tab; that receipt alone was not counted as verified typing. The owned marker was later visible on the first new tab. This does not establish a general focus/timing guarantee or explain the extra tab.
- Strict `set_value` on the current new tab passed independent native UI and screenshot readback: `LPT-662 bundled runtime verified`.
- Reusing the consumed observation refused locally: `Stale or missing observation_id/window_ref. Observe again.` No stale input was sent.
- Both new tabs were cleared only after matching the exact owned marker, verified blank and unmodified, and closed through observed native Close Tab controls. The original two restored tabs remained unchanged. Observed Close Window ended the task-launched window; no discard or save operation was used.
- A final discovery returned zero Notepad windows. `computer_close` released the runtime and task references. No task UI remained.

Window overview pixels and native accessibility data were read directly. No personal browser, desktop-wide pixels, alternate capture/input backend or focus repair was used. UIA can still take foreground/focus; its receipt does not guarantee app effect or non-interference. The accepted capture-fallback risk is unchanged.

## Regression and human-visible evidence

Final implementation checks passed: **358 unit tests in 41 files**, **10 real-Pi integration tests in 8 files**, TypeScript and diff checks. Integration fixtures exercise contracts, not live OS/app support. A reproduced concurrent-startup bug was fixed: two first calls now share one checked MCP child rather than initializing two children; the regression also checks child EOF cleanup.

Actual `inspect_tui` captured Herdr pane `w3N3:p8`, 164×57 cells, live bottom, revision 208. It showed readable native-action warnings, `remaining_notepad_windows:0`, the runtime-close result and the concise support-boundary summary. Long structured blocks were collapsed normally; no broken borders or stray escape codes were visible. This was the human viewport, not an inferred rendering from JSON.

## Limits and retained behavior

Linux/macOS are build, package-install and API-checked targets only. Their native window lifetime binding is deferred by the owner: metadata may be available, but window launch/control explicitly refuses before dispatch. No PowerShell peer or reusable PID/window-ID substitute runs on those targets. Windows/WSL keeps its checked lifetime guard.

Trusted runtime overrides still work and keep their exact legacy hash/version checks. Startup does not download, auto-update, repair a changed cache, install services or alter PATH/trust/permissions. Missing packages and incompatible bytes fail before startup/input. The separate Qt overlay and classifier environment are not bundled.

[Native draft PR 13](https://github.com/alexshpunt/cua/pull/13) remains a stacked build/package change. This evidence is not upstream approval, merge readiness, a full desktop feature matrix or independent concurrent-user support.
