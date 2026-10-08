# Bundled CUA runtime

Computer Use selects a native CUA package installed with the extension. It does not download a driver at first use or search for a separate CUA installation.

The private package installation uses the existing Verdaccio registry:

```sh
pi install npm:@alexshp/pi-agent-computer-use
```

Keep optional dependencies enabled. They carry the native packages. An update installs a new extension version with its exact native package versions; it does not auto-update CUA at startup.

## Platform boundary

| Execution target | Package | Current boundary |
| --- | --- | --- |
| Windows x64, including Windows-host control from WSL x64 | `@alexshp/cua-runtime-win32-x64` | Windows/WSL is the live-qualified GUI environment. |
| Linux x64 outside WSL | `@alexshp/cua-runtime-linux-x64` | Build, installation and API checks; window lifetime/control deferred. |
| macOS Intel | `@alexshp/cua-runtime-darwin-x64` | Build, installation and API checks; window lifetime/control deferred. |
| macOS Apple Silicon | `@alexshp/cua-runtime-darwin-arm64` | Build, installation and API checks; window lifetime/control deferred. |

npm sees WSL as Linux. The Windows package therefore permits Linux x64 installation too. WSL selects Windows-host control; ordinary Linux selects Linux. Windows ARM64 and Linux ARM64 are outside this build matrix.

All platforms use the same `computer_*` tools. Linux/macOS can expose read-only native app/window metadata, subject to native permissions. They do not issue usable window references or launch/control windows until native lifetime binding is verified. This is an explicit `window_lifetime_unavailable` refusal, not a pid/window_id substitute. Those platforms never start the Windows PowerShell identity peer. Unsupported native routes refuse without another backend or input fallback.

A successful build or MCP startup is not a live GUI qualification. Neither UIA nor background delivery guarantees that the user's focus stays unchanged. See the [accepted semantic-action limits](semantic-actions-results.md).

## Files and startup

Each native package carries a source/version manifest, every runtime file hash, MIT licensing and third-party notices. Windows includes `cua-driver.exe`, `cua-cursor-theme.exe` and `cua-driver-uia.exe`. Linux/macOS include `cua-driver` and `cua-cursor-theme`.

The extension pins the complete set's source, version and hashes separately from package metadata. Missing packages, a wrong target/source/version, missing companions/notices or changed bytes refuse before driver startup. No startup repair silently replaces those files.

On WSL, verified Windows files are copied into a source-specific cache under the Windows user's Local Application Data directory:

```text
PiComputerUse/native-runtimes/<source>/win32-x64/runtime/
```

A bounded system query finds that directory. Copying uses a private staging directory and atomic promotion. Every reuse/startup checks the pinned bytes. A changed existing cache refuses; it is not overwritten. Old installed runtime directories remain untouched. This avoids depending on Linux executable bits for npm's `.exe` files.

The extension owns one MCP child. It disables telemetry/update checks, requires the pinned server version and EOF-aware receiver, and reads available native tool schemas. Unsupported tools never become physical fallback calls. Closing the session releases the child and any Windows identity peer, not application windows.

## System requirements

- Windows artifacts are unsigned development builds. Shipping a UIAccess helper does not grant UIAccess rights or bypass Windows trust policy. WSL needs a working Windows interop endpoint.
- Linux targets glibc 2.31 or newer. CUA needs the relevant X11/Wayland libraries, a working display/session bus and any compositor/portal permissions. Portal input is built in; PipeWire ScreenCast is not. Do not assume every Wayland compositor supports capture or input.
- macOS packages have a macOS 13 deployment target and build/start on matching macOS 26 CI runners. They are not notarized or signed with a developer identity. Accessibility and Screen Recording approval remain OS requirements; no permission-policy bypass is included.
- The optional Windows Qt overlay and classifier/model environment are separate. Their runtimes are not included in the native driver package.

## Overrides and rebuilding

Trusted `.pi/computer-use.json` settings and `CUA_DRIVER_PATH` still override automatic package selection. Existing qualified Windows profiles keep their exact byte/version checks. Agent tool arguments cannot select an executable or profile.

The fork's `native-runtime-build.yml` builds Windows x64, Linux x64 and both Mac architectures from one immutable commit. Each native runner installs its npm archive, verifies companions/notices/hashes and repeats read-only initialize/tools/list checks from the installed path. Only a complete four-target set can be pinned and distributed. The workflow does not publish publicly, install services, change PATH or use signing credentials.

The Linux/macOS window-lifetime work is deliberately deferred by the owner. It needs its own live qualification before window control can be enabled.
