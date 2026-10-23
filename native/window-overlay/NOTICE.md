# Qt notice and replacement instructions

This helper dynamically uses Qt 6.11.3 Core, Gui, Widgets and the Windows QPA plugin. Qt is copyright The Qt Company Ltd. and other contributors. These Qt components are used under the LGPL version 3 option. Copies of LGPLv3 and GPLv3 are in `licenses/`. The original Qt DLLs are not patched.

The release directory contains `qtbase-source.tar.gz` from the exact source revision named in the installed Qt kit's SBOM: `5a1194b2d368e2d72c230205c464b04a2f23eccd`. It includes the Qt build files and third-party sources. `qt-kit-qconfig.pri` records the installed kit's build settings. `helper-source/` contains the helper's source and CMake build file. Keep these source files available alongside the runtime when supplying this bundle to someone else; a link to upstream alone is not our source-delivery method.

Qt also includes third-party code with its own terms. `licenses/qtbase-sbom.json`, `qtbase-attributions.json` and the unmodified license texts preserve a conservative set of qtbase notices. This set includes some components not linked by this helper. The corresponding source archive keeps their original copyright notices. The Qt Windows entry point has separate BSD-style terms in that source tree.

## Replace Qt

Close the helper before replacing files. Keep the DLL names and compatible interfaces, then replace `Qt6Core.dll`, `Qt6Gui.dll`, `Qt6Widgets.dll` and `platforms/qwindows.dll` with your compatible modified builds. `qt.conf` loads plugins beside the executable. The helper does not enforce DLL hashes, signatures or a private Qt loader. No restriction is imposed on replacing Qt or reverse engineering needed to debug Qt modifications.

Build Qt with its supplied CMake/configure files for Windows x64 and a compatible MSVC toolchain. Build the helper with `scripts/build-window-overlay.ps1 -QtPrefix <your-compatible-Qt-kit>`. Use the new helper through the trusted `PI_WINDOW_OVERLAY_PATH` environment variable or install its runtime directory in the documented user-local location. No service, administrator account or locked installation is required.

This is a private local Windows deployment, not a public binary release or a legal compliance opinion. Public redistribution needs a review of the helper's own licensing terms, the complete corresponding source and build information, all third-party terms, and the Microsoft runtime distribution rules. Dynamic linking by itself does not remove those duties.
