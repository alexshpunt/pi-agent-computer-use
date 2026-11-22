# Session window streams

Every isolated session streams its windows to the machine that hosts it, outside the agent's tool calls and outside the model's context. A tile host, such as the desktop-layer [session tiles](session-tiles.md), shows them live.

## How it works

```
isolated session (agent user)                    host machine (the human's user)
  cua-spacesd 127.0.0.1:<port>  ── stream relay ──▶  stream hub 127.0.0.1:<port>  ◀── tile hosts (WebSocket)
  PrintWindow capture, H.264        (authenticated      gRPC + /media per window        ◀── Pi: agent activity
                                     reverse channel)
```

- The session starts `cua-spacesd` from the bundled runtime next to the driver. It listens only on the session's loopback, with a token made for this session and passed in its environment. It captures each window with PrintWindow (Windows Graphics Capture does not work in these headless sessions) and encodes H.264 with OpenH264.
- The session cannot accept connections from the host, so its start script keeps spare connections from spacesd to the host through the session relay's third channel, `stream`. Each spare proves the session key before it carries bytes, like the driver and identity channels. The relay writes one marker byte to a spare when it pairs it with a hub connection; the session then connects it to spacesd and opens a new spare, so three always wait however many windows stream.
- The stream hub runs where the relay runs: inside Pi for this machine's sessions, inside the relay worker over SSH for another machine's. It talks to spacesd (`WindowsService.WatchWindows`, `StreamService.OpenMedia`, the rcdp v2 `/media` socket) and serves tile hosts on one WebSocket.
- Pi posts the agent's window activity to the hub: each observation and action with its window, screen point and outcome, never images or typed text. A tile host draws the agent cursor at the point.

Nothing is captured until a tile host subscribes to a window. A window that does not change sends almost nothing.

## Find the sessions

Each session writes `stream.json` to its folder in the human's profile, `%LOCALAPPDATA%\PiComputerUse\sessions\<session>\stream.json`, and the folder is removed when the session closes:

```json
{ "version": 1, "session": "is-1a2b3c4d", "agentUser": "F4-K5", "url": "ws://127.0.0.1:52345/v1/stream", "token": "<64 hex>" }
```

The agent user cannot read that folder. A file whose hub does not answer belongs to a Pi process that ended without closing its session.

## Protocol, version 1

Connect to `url?token=<token>` (or send `Authorization: Bearer <token>`). Up to eight viewers per session.

Messages from the hub, JSON text:

| Type | Fields | When |
| --- | --- | --- |
| `hello` | `version` 1, `session`, `windows`, `activity` (latest or `null`) | On connect |
| `windows` | `windows` | A window appears, closes, moves, resizes, retitles or changes state |
| `stream` | `window`, `state` `open`, `retrying` or `ended`; when open `codec` `h264`, `maxFps`, `maxDimension`; when retrying or ended `reason` | A subscribed window's stream starts, fails or drops and retries every second, or ends |
| `activity` | `window` (id or `null`), `pid`, `kind` (`overview`, `detail`, `inspect`, `verify`, `action`), `action`, `outcome`, `point` `{x,y}`, `region` `{x,y,width,height}`, `at` (ms since epoch) | The agent observed or acted in a window |
| `error` | `message` | A request was refused |

A window is `{id, title, app, pid, bounds: {x, y, width, height}, state, kind, focused, onScreen, z}`, front to back by `z`. `bounds`, `point` and `region` use the session desktop's pixels, so the cursor's place in a tile is `point - bounds`, scaled to the tile. An action on an element has the element's `region` and its centre as `point`.

Binary messages carry one H.264 access unit each (Annex B; keyframes carry SPS and PPS):

```
u32 big-endian header length | JSON header | payload
header: {"window": id, "sequence": n, "keyframe": bool, "width": n, "height": n, "timestampUs": n}
```

Messages to the hub, JSON text:

| Type | Fields |
| --- | --- |
| `subscribe` | `window`, `maxFps` 1–60 (default 10), `maxDimension` 0–8192 (0 = native). Sending it again changes the limits. |
| `unsubscribe` | `window` |
| `keyframe` | `window`: ask for a keyframe, for example after a decoder error |

The hub opens one capture per window and gives it the highest rate and size its viewers ask for. A viewer's first frame of a window is a keyframe; a viewer that falls more than 4 MiB behind skips to the next keyframe. In a browser or WebView2, `VideoDecoder` from WebCodecs decodes the payloads (`codec: "avc1.42E01F"`, Annex B input).

## Measure an agent window read

A fresh `Read` with the `image` view takes one driver capture and checks the window's lifetime before and after it. It does not use the tile stream, even when a tile is already subscribed.

Run the read latency check on the Windows machine's WSL for a same-host measurement. Install this repository's locked dependencies and set up the isolated-session runtime first. The check runs a real Pi with a scripted model, opens its own isolated session and Notepad window, and takes five warm-up reads followed by ten measured reads. It fails if any local 320 px read takes 150 ms or more. Session startup and teardown are outside the samples.

```sh
LIVE_MACHINE=local PI_COMPUTER_PI_COMMAND="$PWD/node_modules/.bin/pi" \
  npm run test:live -- test/live/window-read-latency.live.ts
```

From another machine, set `LIVE_MACHINE=zinpc` to measure the SSH route to a configured `zinpc` machine. The check reports the SSH timings without applying the same-host limit. Set `LIVE_READ_MAX_LONG_EDGE=4096` to measure a full-size window.

## Limits

- On Windows, spacesd scales H.264 frames to the requested `maxDimension` and the encoder's size limits. It does not resize the window. Use the frame header for encoded dimensions and `bounds` for coordinates in the session desktop. Isolated session windows are at most 1024×768.
- Input through a stream is not supported: streams are view-only.
- spacesd's own cursor overlay window exists in the session (full screen, transparent). It does not appear in window captures.
