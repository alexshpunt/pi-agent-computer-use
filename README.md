# Pi Agent Computer Use

A standalone computer-use proof of concept for Pi. The final goal is an extension for [Pi Agent IDE](https://github.com/alexshpunt/pi-agent-ide), using the IDE's shared, intent-based tool primitives.

## Why a separate extension

Pi Agent IDE already has vision and other capabilities beyond code work. Its scope has grown. Over time, the IDE should return to code editing, code understanding, debugging, and related development work. This extension should become the computer-use implementation.

We want one window-first computer-use interface for all apps, including browsers: discover a window, read its native UI tree and screenshot, then click or type. Use Cua Driver's capabilities first and add missing behavior in the adapter when its public API allows it. A user-approved CUA fork may add missing native capabilities; continuous Windows drawing is the first approved case. Continuous paths use an explicitly selected, qualified Windows fork; the existing 0.33.2 install remains available. Do not add a separate tool family for each kind of app.

The exact implementation is still open. These are project intentions, not capabilities available today.

## Migration boundary

First prove computer use through independent tools, without an IDE dependency. Integration and gradual extraction come later. Do not change the working IDE for the PoC. Any future extraction experiment must use an isolated IDE branch/worktree and check the two extensions together in a separate environment before changes reach the normal installation.

The ownership of shared infrastructure, including processes, terminals, browser reads, and images, still needs investigation. It is not decided simply because a resource appears in this pitch.

## Current state

The standalone extension uses Cua Driver 0.33.2 to reach the Windows desktop from Pi in WSL. Six experimental tools find apps, open a new window with its first observation, discover existing windows, read UI state and screenshots, act, and release the runtime. Opening needs no per-window config, PID/HWND lookup, or reload. Live checks opened separate Notepad windows and Calculator, and edited an authorized disposable window from another session. See [the YOLO results and limits](docs/yolo-windows-results.md) and [setup](docs/standalone-poc.md).

YOLO is the default desktop-wide UI mode. The user can select session-owned Safe access with `/computer-mode safe` and return with `/computer-mode yolo`, without reload or target config. Live Notepad checks verified old-reference denial and separate ownership for windows sharing one PID. See [the Safe results and limits](docs/safe-windows-results.md). Neither mode is OS isolation. The final IDE provider API and migration route are still open. The [earlier single-window PoC report](docs/standalone-poc-results.md) is historical.

**Separate `browser_*` tools are temporarily disabled.** Use the same six `computer_*` tools for browser windows and other apps. YOLO permits existing windows without a session-ownership or browser-page binding requirement; Safe remains session-owned. Read [the operating skill](.pi/skills/computer-use/SKILL.md). Native window captures default to a 500px long edge with Lanczos3. Window input uses returned-image coordinates local to the window; window identity remains separate from geometry: read-only zoom keeps its original local region through movement, resizing and scale changes. Native accessibility is not a promise of the retained browser adapter's DOM semantics, URL navigation or hint batching.

`computer_act` also supports complete keys/chords, text with per-character delay, right/double clicks, scroll and straight drags. Known keyboard or independent-stroke sequences can consume one overview and run without intermediate captures. They stop with a truthful completed prefix on refusal or uncertainty. No raw cross-call holds or hover are exposed. Optional `drag.via` keeps the left button down through intermediate points when a qualified Windows fork is explicitly selected; the default 0.33.2 driver refuses this path before batch input. See [complete input usage](docs/complete-input.md) and [verified results and native limits](docs/complete-input-results.md).
The public fork passed unchanged Windows build, native cancellation/release, compatibility and a real Paint brush picture. This installation now selects its exact qualified bytes from a separate user-local directory; fresh installations still default to 0.33.2. See [Windows held-path results](docs/windows-held-path-results.md). Bounded simultaneous key holds, including Shift-held clicks and brush paths, now use a separately qualified key-hold fork in this installation. Keys release within one command; no cross-call hold is exposed. See [Windows key-hold results](docs/windows-key-hold-results.md).

The [retained browser adapter](docs/browser.md) and its [verified CUA results](docs/cua-browser-results.md) remain available for standalone research, not production agent tools. Playwright and the duplicate browser worker/image engine are removed. Sharp is used for fresh display-region crop/resize and hint annotation above CUA pixels. The earlier [Playwright results](docs/browser-results.md), [focus results](docs/browser-focus-results.md), [resampling results](docs/vision-scale-results.md) and [saved-crop results](docs/browser-crop-results.md) are historical, not current API promises. Native pixels can lag live UI state; input success is not proof of fresh paint.

Window overviews now expose bounded native `ui` resources and snapshot-scoped short hints. Codemode can search, scope and inspect the collected tree without another native walk, highlight an exact element, request fresh native element detail and use current hints for supported input. Labelled PNGs preserve raw returned bytes privately; the viewer has a later-capture hint switch and exact raw/sent comparison. See [usage and limits](docs/ui-resources.md). LPT-386–388 passed native, production Codemode and viewer/TUI checks; see [results and limits](docs/ui-resource-results.md).

`computer_observe({display:"primary"})` reads the full primary Windows display in YOLO; Safe refuses it. Display and window images share source metadata and the native 500px cap settings. Display reads grant no input. Read-only window zoom and fresh primary-display crop use a rectangle in the latest overview; see [detail usage](docs/native-detail.md). See [the source contract](docs/observation-sources.md) and [verified results](docs/observation-sources-results.md).

On Windows, an optional user-local Qt Widgets helper flashes human-only overview outlines, requested zoom/crop regions and grounded action targets. It does not change CUA captures/input or the user's keyboard focus. See [the helper contract](docs/window-overlay.md), [verified costs and limits](docs/window-overlay-results.md), [region/action results](docs/region-highlight-results.md), and [the computer-use E2E ledger](docs/computer-use-e2e-ledger.md).

Images stay in normal Pi context, including user attachments, tool/Codemode images and detail. This extension does not remove older images or rewrite history. Pi's normal compaction owns context reduction; the debug viewer keeps only three display cards. See [the retention contract and transport checks](docs/image-context.md).

The opt-in [browser profiler](docs/browser-profile.md) times the retained browser adapter and ordered native/identity/frame calls in a separate synthetic run. It does not profile normal tools continuously or touch the paused game.

- [Linear project](https://linear.app/alexshpunt/project/pi-agent-computer-use-614e5fa78124)
- [Research task: define the first safe migration](https://linear.app/alexshpunt/issue/LPT-355/define-the-first-safe-computer-use-migration)
- [Research references](docs/research-references.md)

[External source research](docs/research/external-implementations.md) is available. Automatic YOLO opening is tracked in [LPT-363](https://linear.app/alexshpunt/issue/LPT-363). [Safe access](https://linear.app/alexshpunt/issue/LPT-365) follows YOLO; [sandbox research](https://linear.app/alexshpunt/issue/LPT-364) is separate. IDE inventory, extraction, and coexistence work remain deferred.

[Sandbox boundary research](docs/research/sandbox-boundaries.md) compares Windows Sandbox, a Windows VM and a private Linux desktop in WSL. It proposes a separately approved guest-control experiment; no guest isolation or connectivity has been tested.