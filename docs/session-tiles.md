# Session tiles

While agents work in isolated sessions, the human sees their windows live as tiles on the Windows desktop: above the wallpaper, under the desktop icons and under every normal window. A hotkey raises the same tiles over all windows and the next press puts them back.

## What the human sees

- One tile per app window or dialog of every open isolated session on the machine, from every Pi process. A tile has a caption with the agent user, the window title and the agent's current action, and shows the window at most at its own pixel size.
- The agent's cursor appears in the tile where the agent last observed or acted, for a few seconds after each action.
- On the desktop layer the tiles are only visible where no window covers the desktop. Clicks there go to the desktop as before; the tiles never take the focus.
- **Ctrl+Alt+Space** shows the tiles over all windows on a dimmed backdrop. Clicks pass through to the windows below. The next press puts the tiles back under the icons.

## How it runs

- Opening an isolated session starts the tile host on the session's machine, in the signed-in user's desktop session, also when Pi controls that machine over SSH. One host per desktop shows every session; a second start finds the running one. The host exits about 20 seconds after the last session closes; a session that opens while it leaves keeps it running or starts a new one. After an update of the extension, a host of the previous version keeps showing the tiles until it exits; the next session after that starts the new version.
- The host is `pi-tile-host.exe`, a small WinForms program with a WebView2 page. The page connects to each session's stream hub ([Session window streams](session-streams.md)), decodes the H.264 frames with WebCodecs and draws the tiles. Each tile asks for frames no larger than itself, at most 10 per second. Windows are captured only while their tiles are shown: not while a window covers the whole desktop, and not for a tile the work area has no room for.
- It finds sessions through their `stream.json` files under `%LOCALAPPDATA%\PiComputerUse\sessions\` and skips files whose hub does not answer.
- The session's description (Read its `computer:sandbox/...` address) names the tiles' state; a failed build or start shows there with its reason and never affects the session.

### Build on the machine

The host is compiled on the machine that shows it, the first time a session opens with a new version of its sources:

1. Pi copies the sources from `native/tile-host/` to `%LOCALAPPDATA%\PiComputerUse\tile-host\<version>.staging-<id>\`.
2. The WebView2 SDK package `Microsoft.Web.WebView2` (version pinned in `src/tile-host.ts`) is downloaded from NuGet once, checked against its pinned SHA-256 and unpacked to `tile-host\webview2-sdk-<version>\`. Its license (BSD-3-Clause) stays next to the DLLs.
3. The .NET Framework 4.8 compiler that ships with Windows (`csc.exe`) builds `pi-tile-host.exe`, and the folder is renamed to `tile-host\<version>\`, where `<version>` is a hash of the sources, the SDK pin and the build recipe.

The machine needs the WebView2 Runtime, which Windows 11 includes, and network access to `api.nuget.org` for the first build. The page keeps its WebView2 data in `tile-host\webview2-data\`; the host writes a short log to `tile-host\host.log`.

## The desktop layer

On Windows 11 24H2 and later the desktop window `Progman` holds the icon view (`SHELLDLL_DefView`) and the wallpaper (`WorkerW`). The host's window is a layered child of `Progman` placed directly under the icon view. Only DirectComposition content is drawn there, so the tiles are a WebView2 page and the window has no redirection bitmap: wherever the page is transparent, the wallpaper shows.

- A wallpaper app such as Wallpaper Engine or Lively can reorder `Progman`'s children. A WinEvent hook on `EVENT_OBJECT_REORDER` puts the tiles back under the icons right after any reorder.
- When Explorer restarts, `Progman` and the tiles go with it; the host recreates its window on the `TaskbarCreated` broadcast.
- Earlier Windows builds keep the icon view inside a `WorkerW`. The host does not support them: it logs that the desktop has no raised layer and shows no tiles.

## Limits

- The tiles sit on the primary display's work area.
- Tiles only show; input into a session through its tile is not supported.
