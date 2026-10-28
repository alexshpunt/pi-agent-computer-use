# Bundled CUA runtime

The npm package carries one native runtime: Cua Driver 0.38.0 for Windows x64, built from source `505d090e` of the [alexshpunt/cua](https://github.com/alexshpunt/cua) fork. [FORK.md](https://github.com/alexshpunt/cua/blob/pi-computer-use/FORK.md) lists the fork's changes. The `windows-desktop` profile needs no separate driver configuration:

```sh
pi install npm:pi-agent-computer-use
```

An update installs a new extension version with its exact runtime. Computer use never updates the driver on its own.

## Where the files come from

The files are published as the fork release [`pi-runtime-0.38.0-505d090e`](https://github.com/alexshpunt/cua/releases/tag/pi-runtime-0.38.0-505d090e): `cua-driver.exe`, `cua-driver-uia.exe`, `cua-cursor-theme.exe`, `LICENSE.md` and `THIRD_PARTY_NOTICES.md`. They were cross-built with Rust 1.97.1, cargo-xwin 0.23.1 and LLVM 18, with a static CRT and canonical Windows manifest resources. They are not copies of a GitHub Actions artifact.

`src/runtime-pins.json` pins the source, the version, the release URL and the SHA-256 of every file. Before packing, `npm pack` runs `scripts/fetch-runtime.mjs`, which downloads the files into `native-runtime/win32-x64/runtime/` and checks each hash. The directory is not committed to Git.

An installation from Git has no packaged files. On first use, computer use downloads the same pinned files once into that directory, with the same checks, and names their source in `native-runtime/win32-x64/runtime.source`. When a pull changes the pins, the earlier download is moved aside to `runtime-<source>` and the pinned one is downloaded. A failed download, a changed file or a folder with no recorded source refuses and says which folder to move away; nothing is replaced silently.

## Platforms

| Pi runs on | Runtime |
| --- | --- |
| Windows x64 | Runs the packaged files directly. |
| WSL x64 on Windows | Copies the packaged files to a Windows-host cache and controls the Windows desktop. |
| Linux outside WSL, macOS, ARM64 | No runtime is shipped; computer use refuses with `unsupported_native_target`. |

Linux and macOS window control is not verified, so no runtime is shipped for them.

## Startup checks

Every start checks all five pinned files. A missing file, a changed byte or a symlink refuses before any driver process starts.

From WSL, the verified files are copied into a source-specific cache under the Windows user's Local Application Data directory:

```text
PiComputerUse/native-runtimes/<source>/win32-x64/runtime/
```

A bounded system query finds that directory. Copying uses a private staging directory and atomic promotion, and every reuse checks the pinned bytes again. A changed existing cache refuses; it is not overwritten. Old runtime directories stay untouched. Running from a Windows path avoids depending on Linux executable bits for the `.exe` files.

Computer use owns one MCP child. It disables telemetry and update checks, requires the pinned server version and the EOF-aware receiver, and reads the native tool schemas. Unsupported tools never fall back to other input. Closing the session releases the child and any Windows identity peer, not application windows.

## System requirements

- The Windows binaries are unsigned. Shipping a UIAccess helper does not grant UIAccess rights or bypass Windows trust policy.
- UIAccess/trusted-path deployment and UWP or elevated-window targets are not qualified by this runtime profile.
- Physical multi-monitor, mixed-DPI and negative-origin layouts, and concurrent desktop ownership, need separate qualification.
- WSL needs a working Windows interop endpoint.
- [Native visuals](native-observability.md) require advertised driver capabilities. The adapter alone does not qualify a renderer or establish screenshot exclusion.

## Overrides

A trusted `.pi/computer-use.json` (`command`, `runtime`) or `CUA_DRIVER_PATH` overrides the packaged runtime, for example to try another qualified fork build. Each named profile keeps its exact byte and version check. Agent tool arguments can never select an executable or a profile.
