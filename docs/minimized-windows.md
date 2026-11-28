# Minimized windows

A minimized Windows window has no fresh pixels to read. Windows stops composing it, so Windows Graphics Capture delivers no frames, `PrintWindow` and `BitBlt` return black or the caption strip, and a DWM thumbnail stays on the last visible frame. Many apps also stop rendering: Chrome stops its animation frames and reports the page as hidden. Measured on Windows 11 with a Chrome tab running Three.js and with a Direct3D app that keeps presenting, no read-only API returned a new frame of a minimized window.

The only way to a fresh frame is to make the window non-iconic for a moment. With a driver that supports `minimized_capture`, every window image read does this for a minimized window and puts everything back.

## What a read does

1. The window gets the extended styles `WS_EX_LAYERED`, `WS_EX_TRANSPARENT` and `WS_EX_NOACTIVATE` and a layered alpha of 0: fully transparent, click-through and never activated. Window animations are switched off for it meanwhile.
2. `ShowWindow(SW_SHOWNOACTIVATE)` restores it, to maximized if it was minimized from maximized. A `HWND_TOPMOST` z-order step keeps Chromium from marking the restored window hidden again.
3. After `minimized_settle_ms` (default 150 ms) the driver captures the ordinary window. An app that was minimized for minutes can need longer for its first frame, and the capture then shows only its frame colour. The driver detects an image of one flat colour, waits 250 ms and captures again, up to four times; `repaint_waits` in the result says how often.
4. `SW_SHOWMINNOACTIVE` minimizes it again and every changed style, z-order and animation setting is put back.

A read takes about 0.2–0.6 s. The foreground window, the window's placement and its styles are the same before and after. The result names the peek in `structuredContent.minimized_capture` (settle and hold time, foreground-returned flag) and reports the restored rectangle as `window_bounds`; the observation `source.visibility.minimized_capture` carries the times.

## Side effects

- The app sees itself restored and visible for the length of the read, for example a chat app may count messages as read, and the taskbar button changes state for that moment.
- The window is briefly topmost, though transparent and click-through.
- The accessibility tree is still read from the minimized window.
- The driver refuses and leaves the window untouched when the window belongs to an elevated process, draws with per-pixel alpha, does not respond or does not restore within 1.5 s.
- Some apps activate themselves when restored (Character Map does). The driver hands the foreground back to the window that had it, within about 10 ms, and says so with `foreground_returned: true`. The window is minimized again either way.
- The driver writes the window's original state to `%LOCALAPPDATA%\cua-driver\minimized-peek-journal-<pid>.json` before the first change. A driver that dies mid-read leaves a transparent window; the next driver start restores it.

## Turning it off

A window read refuses a minimized window, as before, when the project sets `"minimizedCapture": "refuse"` in `.pi/computer-use.json`. The default is `"peek"`. The extension sends the request only to a driver that lists the `minimized_capture` argument of `get_window_state`; an older driver, such as a `driverOverride` build from before the feature, keeps refusing with its native reason. The pinned runtime (0.62.1 and later) supports it, so a default install reads minimized windows without any setting.

The driver's own default is `refuse`: a client that does not ask gets no change to any window.

## Testing it

`demo/animated-3d` is a Three.js page whose cube moves every frame. Minimize its Chrome window, read it twice a second apart and compare the images: they differ.
