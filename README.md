<p align="center">
  <img src="assets/banner.png" alt="Pi Agent Computer Use" width="100%">
</p>

<h1 align="center">Pi Agent Computer Use</h1>

<p align="center">Lets your Pi agent use Windows apps and browsers: it reads the window, clicks, types, draws and checks what happened.</p>

<div align="center">

[![npm version](https://img.shields.io/npm/v/pi-agent-computer-use)](https://www.npmjs.com/package/pi-agent-computer-use)
[![npm downloads](https://img.shields.io/npm/dm/pi-agent-computer-use)](https://www.npmjs.com/package/pi-agent-computer-use)
[![CI status](https://github.com/alexshpunt/pi-agent-computer-use/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/alexshpunt/pi-agent-computer-use/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/npm/l/pi-agent-computer-use)](./LICENSE)

</div>

<div align="center">

[![Pi package](https://img.shields.io/badge/pi-package-6b4fbb)](https://pi.dev/packages/pi-agent-computer-use)
[![Works with Pi Agent IDE](https://img.shields.io/badge/works%20with-Pi%20Agent%20IDE-2f7d4a)](https://github.com/alexshpunt/pi-agent-ide)
[![Platform: Windows from WSL](https://img.shields.io/badge/platform-Windows%20from%20WSL-0078d4)](#platforms)

</div>

Ask your agent to do something on your computer, for example "open Paint and draw a house", "fill in this form in my browser" or "check what the settings window says". It finds the window, reads its controls and screenshot, acts, and reads it again to see whether it worked.

## Summary

Pi Agent Computer Use gives the [Pi coding agent](https://pi.dev/) one interface for every Windows app, browsers included. The agent finds a window, reads its accessibility tree and screenshot, and then types, clicks, drags or runs a browser action. Input always targets the latest thing the agent saw, and every result says what was delivered and what is still unknown.

| Work                                   | How                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------- |
| Find windows, apps and displays        | Search or Read `computer:machine/local/windows`, `/apps` and `/displays`     |
| See a window                           | Read `computer:window/...` for its UI tree, short element hints and a screenshot |
| Act on what it saw                     | Write text or Insert one JSON action into the returned observation          |
| Work in web pages                      | Playwright snapshots and actions in browsers it opens or attaches to        |
| Check the result                       | `wait_for`, `verify`, change lists and fresh Reads                          |
| Work away from your desktop            | Windows Sandbox, isolated agent sessions and other machines over SSH        |

[Cua Driver](https://github.com/trycua/cua) does the native capture and input, and [Playwright](https://playwright.dev/) handles web pages.

### With Pi Agent IDE or without it

If you have [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide), computer use plugs into its `read`, `search`, `write` and `insert` tools. The agent then uses the same tools for files and windows, and the results show up in the IDE's tool panels.

Without the IDE, computer use adds its own `computer_read`, `computer_search`, `computer_write` and `computer_insert` tools. They stay out of the tool list until the agent looks for them with `tool_search`, and after that it calls them directly. Both modes take the same addresses and commands, return the same results and work from Codemode scripts. Each Pi session picks the mode itself, so you don't configure anything.

### YOLO and Safe mode

Computer use is built for an agent you trust with your desktop. In YOLO mode, the default, the agent can read and operate any window you point it at, read whole displays, attach to browsers that are already running and start programs by path. You get the most out of it this way.

YOLO also means the agent can click and type anywhere you could. If a misclick would fuck up something you care about, switch to Safe mode with `/computer-mode safe`, or give the agent a sandbox. In Safe mode the agent only sees and touches windows it opened itself, and it can't read displays or start arbitrary programs. Neither mode isolates anything at the OS level; sandboxes and isolated sessions do that (see below).

### UI structure and screenshots

A window Read returns the app's UI Automation tree: roles, names, values, enabled state and bounds. Each element gets a short hint such as `1:a`, and the hints are drawn on the screenshot too, so the agent can point at a button by its hint instead of guessing coordinates.

From there the agent can:

- search the tree of an observation without capturing again;
- inspect, scope or highlight one element, or read its full text;
- ask for only the `image`, only the `ui`, or both (`full`);
- read only what changed since the last read with `changes`;
- run `ocr` on canvases and games, or `regions` for icons and text areas found by Cua perception;
- zoom into part of the latest overview, or crop one element at full resolution;
- capture a short `sequence` of frames to watch an animation or a progress bar, then pick the frames it needs;
- read a window's `state` to see whether the app is hung and how much memory it uses.

### Input

Input goes to the window the agent observed. It can:

- type literal text, press keys and chords, and hold several keys at once;
- click, double-click, right-click, hover and scroll by wheel detents;
- drag in straight lines or draw continuous brush strokes through many points;
- run a timeline of timed key, button, mouse and pen events, with raw relative mouse motion for pointer-locked apps and pen pressure and tilt;
- send up to 2000 known keyboard, click and stroke steps in one call, which is enough for a whole drawing;
- invoke, select or set values through UI Automation, and open menu items by their labels.

Input starts in the background where Windows allows it, so your own pointer and focus stay put. Foreground input is a separate step the agent has to ask for, and it pauses whenever you touch the keyboard or mouse.

### Results and checks

Every action returns a receipt. `delivered` means it went through, `refused` means nothing was sent, and `unknown` means it may have reached the app, so the agent reads again before doing anything else instead of repeating it. Add `"expect"` to an action to check a condition afterwards, or `"successor":true` to get a short list of what changed. `wait_for` and `verify` check UI conditions, and `batch` runs a short chain that stops at the first failure. In Codemode the receipts are plain objects, so a script branches on `outcome` without parsing text.

### Browsers and apps built on them

Web pages go through Playwright, with aria snapshots, element refs, locator actions and Playwright's waiting. The agent can:

- open its own Chrome, Edge or Firefox with a throwaway profile, or with a persistent agent profile for sites that need a login;
- attach to a Chrome or Edge that is already running, including your own profile if you let it;
- attach to browsers inside Electron, CEF and WebView2 apps, and to VS Code's built-in browser through the included Pi Browser Bridge;
- switch tabs, answer JavaScript dialogs, upload and download files, run page code and read the console and network log.

The browser's toolbar, tabs and system dialogs are still ordinary windows, so the agent can use native input there as well.

### Sandboxes, sessions and other machines

- Windows Sandbox gives the agent a throwaway Windows with its own driver. You choose which folders it can see.
- An isolated agent session is a separate Windows session on the same machine with its own desktop, clipboard and input. Several agents can work at once, each with foreground input, and none of them touches your desktop.
- Browsers the agent opens use throwaway profiles that get deleted when the session closes.
- Another Windows machine with WSL can be controlled over SSH with the same addresses. No ports are opened on either side.

### Files, clipboard and recordings

Each session has its own folder on the controlled machine for files an app opens or saves. In YOLO mode the agent can also read and write the clipboard, record the screen to video, and record what the machine plays, optionally with a transcript.

### Local image classifier

`computer_classify` checks one visual condition on an image with a small local model (TinyCLIP). It's for fast loops such as games, where asking the main model about every frame takes too long.

### Debug viewer and overlay

`/computer-debug` opens a private viewer with the images the agent actually received, its action trace and the capture settings. On Windows an optional overlay briefly outlines the window and target the agent is working on, without taking focus.

## Platforms

Computer use is tested on Windows 11 x64, controlled from Pi running in WSL on the same machine or on another one over SSH. Linux and macOS aren't supported: window control there isn't verified, so no runtime ships for them and computer use refuses with a clear message. Some features need more: Windows Sandbox needs a Windows edition that has it, and isolated sessions need Windows 11 24H2 or newer.

This is experimental and changes often, so interfaces and behavior may still move around.

## Installation

Install [Pi](https://pi.dev/) in WSL first, then install the package:

```bash
pi install npm:pi-agent-computer-use
```

Or install it directly from GitHub:

```bash
pi install git:github.com/alexshpunt/pi-agent-computer-use
```

To try it for one session without changing your settings:

```bash
pi -e npm:pi-agent-computer-use
```

The package carries the Windows Cua Driver runtime, so there's nothing else to download. An install from GitHub downloads the same pinned runtime once on first use. If you want the shared Read/Search/Write/Insert tools, install [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide) too:

```bash
pi install npm:pi-agent-ide
```

Pi packages run with your full system permissions, and this one drives your desktop. Read the code before you install it.

A few features need a one-time setup on the Windows side: Firefox for Playwright, Cua perception for `regions`, MXC for isolated sessions and the VS Code bridge. [The resource guide](docs/computer-resources.md) explains each one.

## Commands

| Command                       | Effect                                                |
| ----------------------------- | ----------------------------------------------------- |
| `/computer-mode safe\|yolo`   | Switch between Safe and YOLO for this session          |
| `/computer-debug on\|off`     | Start or stop the private vision debug viewer          |

## Feedback and contributions

I use this every day on real tasks, but I can only test the machines, apps and workflows I have. If something breaks or doesn't fit how you work, [open an issue](https://github.com/alexshpunt/pi-agent-computer-use/issues) or start a [discussion](https://github.com/alexshpunt/pi-agent-computer-use/discussions). Bug reports, ideas, questions and pull requests are all welcome.

## Documentation

| Document                                                  | Contents                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| [Computer resources](docs/computer-resources.md)          | Addresses, views, commands, browsers, sandboxes, sessions, machines   |
| [Operating skill](.pi/skills/computer-use/SKILL.md)       | How the agent observes, plans, acts and verifies                      |
| [Complete input](docs/complete-input.md)                  | Keys, pointer, drags, sequences and their limits                      |
| [Semantic actions](docs/semantic-actions.md)              | UI Automation invoke, select and set value                            |
| [UI resources and hints](docs/ui-resources.md)            | The native UI tree, hints and local UI operations                     |
| [Window zoom and display detail](docs/native-detail.md)   | Readonly detail from the latest overview                              |
| [Temporal capture](docs/temporal-capture.md)              | Frame sequences and their timing                                      |
| [Selected displays](docs/selected-displays.md)            | Monitor discovery and display reads                                   |
| [Image guides](docs/image-guides.md)                      | Coordinate grid and last-action marks                                 |
| [Visual classifier](docs/visual-classifier.md)            | `computer_classify` setup and use                                     |
| [Vision debug viewer](docs/vision-debug.md)               | What the agent saw and the capture controls                           |
| [Bundled runtime](docs/bundled-runtime.md)                | Native runtime packages and platform boundaries                       |

## License

[MIT](./LICENSE)
