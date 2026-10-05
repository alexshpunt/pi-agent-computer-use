# Pi Agent Computer Use

A standalone computer-use proof of concept for Pi. The final goal is an extension for [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide), using the IDE's shared, intent-based tool primitives.

## Why a separate extension

Pi Agent IDE already has vision and other capabilities beyond code work. Its scope has grown. Over time, the IDE should return to code editing, code understanding, debugging, and related development work. This extension should become the computer-use implementation.

We want a full computer-use library built around simple intentions and shared structures. Instead of adding an unrelated tool for every backend, it should provide computer-use resources through primitives such as `read` and `insert`, with providers for vision, browsers, application processes, images, and UI interaction. The goal is to teach the agent to use the applications we care about.

The exact implementation is still open. These are project intentions, not capabilities available today.

## Migration boundary

First prove computer use through independent tools, without an IDE dependency. Integration and gradual extraction come later. Do not change the working IDE for the PoC. Any future extraction experiment must use an isolated IDE branch/worktree and check the two extensions together in a separate environment before changes reach the normal installation.

The ownership of shared infrastructure, including processes, terminals, browser reads, and images, still needs investigation. It is not decided simply because a resource appears in this pitch.

## Current state

The standalone extension uses Cua Driver 0.33.2 to reach the Windows desktop from Pi in WSL. Six experimental tools find apps, open a new window with its first observation, discover existing windows, read UI state and screenshots, act, and release the runtime. Opening needs no per-window config, PID/HWND lookup, or reload. Live checks opened separate Notepad windows and Calculator, and edited an authorized disposable window from another session. See [the YOLO results and limits](docs/yolo-windows-results.md) and [setup](docs/standalone-poc.md).

YOLO is the default desktop-wide UI mode. The user can select session-owned Safe access with `/computer-mode safe` and return with `/computer-mode yolo`, without reload or target config. Live Notepad checks verified old-reference denial and separate ownership for windows sharing one PID. See [the Safe results and limits](docs/safe-windows-results.md). Neither mode is OS isolation. The final IDE provider API and migration route are still open. The [earlier single-window PoC report](docs/standalone-poc-results.md) is historical.

The browser now uses Cua Driver 0.33.2 only: an owned visible Windows browser, snapshot-scoped short hints, native input and a human-visible agent cursor. Native window PNGs default to 500px long edge with Lanczos3; fresh padded JPEG zoom provides detail. Playwright and the duplicate browser worker/image engine are removed. Sharp is used only for fresh display-region crop/resize above CUA; browser capture and zoom remain native. Existing Pi Codemode batches supported inputs. Before each overview/zoom it raises only its owned window through CUA; keyboard focus may switch. Read [the current browser contract](docs/browser.md), [verified CUA results and limits](docs/cua-browser-results.md) and [operating skill](skills/owned-browser-use/SKILL.md). The earlier [Playwright results](docs/browser-results.md), [focus results](docs/browser-focus-results.md), [resampling results](docs/vision-scale-results.md) and [saved-crop results](docs/browser-crop-results.md) are historical, not current API promises. Native pixels can lag the live window and semantics; input success is not proof of fresh paint.

`computer_observe({display:"primary"})` reads the full primary Windows display in YOLO; Safe refuses it. Display, desktop-window and owned-browser images share source metadata and the native 500px cap settings. Display reads grant no input. Read-only window zoom and fresh primary-display crop use a rectangle in the latest overview; see [detail usage](docs/native-detail.md). See [the source contract](docs/observation-sources.md) and [verified results](docs/observation-sources-results.md).

On Windows, an optional user-local Qt Widgets helper flashes a human-only whole-window frame after observations. It does not change CUA captures/input or the user's keyboard focus. See [the helper contract](docs/window-overlay.md), [verified costs and limits](docs/window-overlay-results.md), and [the computer-use E2E ledger](docs/computer-use-e2e-ledger.md).

Images stay in normal Pi context, including user attachments, tool/Codemode images and detail. This extension does not remove older images or rewrite history. Pi's normal compaction owns context reduction; the debug viewer keeps only three display cards. See [the retention contract and transport checks](docs/image-context.md).

- [Linear project](https://linear.app/alexshpunt/project/pi-agent-computer-use-614e5fa78124)
- [Research task: define the first safe migration](https://linear.app/alexshpunt/issue/LPT-355/define-the-first-safe-computer-use-migration)
- [Research references](docs/research-references.md)

[External source research](docs/research/external-implementations.md) is available. Automatic YOLO opening is tracked in [LPT-363](https://linear.app/alexshpunt/issue/LPT-363). [Safe access](https://linear.app/alexshpunt/issue/LPT-365) follows YOLO; [sandbox research](https://linear.app/alexshpunt/issue/LPT-364) is separate. IDE inventory, extraction, and coexistence work remain deferred.

[Sandbox boundary research](docs/research/sandbox-boundaries.md) compares Windows Sandbox, a Windows VM and a private Linux desktop in WSL. It proposes a separately approved guest-control experiment; no guest isolation or connectivity has been tested.