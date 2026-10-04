# Visible agent browser

Six tools use **Cua Driver 0.33.2** to control one driver-owned visible Windows Chromium browser from Pi in WSL. CUA owns the browser launch, profile, semantic snapshots, native screenshots, zoom and input. There is no Playwright, browser-side Sharp processing, page-JavaScript bridge or Pi Agent IDE dependency.

## Setup and ownership

Use the project-local extension and its declared dependencies. Browser, desktop-window and display routes discover the same qualified Windows CUA 0.33.2 runtime. Missing or wrong runtimes refuse; tools do not install them. A signed/checksummed release is adopted explicitly after compatibility checks, not by automatic startup upgrades.

`browser_open({url})` calls CUA's `isolated_new` route once. It creates a fresh profile, checks the launched PID/window lifetime and binds only that owned browser. It returns the first semantic snapshot and whole-window PNG. A second open refuses while that session exists. Navigate it or close it instead. No personal browser endpoint, profile, tab or permission grant is accepted.

Close ends that exact native session, deletes its owned profile and releases the Driver/identity peer. Unknown cleanup blocks another launch. A profile is browser-data separation, **not OS isolation**.

## Focus and hints

`browser_focus({tab:1})` selects the agent's working surface. It does not activate another tab. Its returned overview raises only the owned browser through CUA and may switch keyboard focus. Current native window-image work requires **exactly one active tab**. `browser_tabs({})` lists only owned tabs; it does not activate them. Standalone tab creation, activation and closure are unavailable on the public CUA route used here.

A full `browser_observe({})` returns CUA semantic text, short lowercase hints and a native PNG. Each semantic observation retires the previous hints. Aliases are never rebound to new snapshot refs or reused after reload/reopen. `image_only:true` captures without discovering targets or renewing hints.

Use hints from the current snapshot, not remembered ones. Four known choices can use that snapshot in one existing Pi Codemode sequence:

```js
for (const hint of ["a", "b", "c", "d"])
  await tools.browser_act({click:hint, observe:false});
const view = await tools.browser_observe({});
text(view.text);
image(view.image);
```

No page/observation IDs are repeated. The extension wraps CUA refs; it adds no executor or DOM target registry. Structured results expose `text`, `elements`, `tabs`, optional `image`, `agent_image` and the [common observation source](observation-sources.md). Forward pixels with `image(view.image)`, not base64 text.

## Supported input

Each `browser_act` accepts one action:

```js
{click:"a"}
{fill:"b", text:"Hello"}
{hover:"c"}
{scroll:{hint:"c", delta_y:600}}
{navigate:"https://example.org"}
{click:{x:150, y:140}}
```

Hint input calls native browser click/type/pointer APIs. Fill replaces a text input, textarea or contenteditable value; unsupported controls refuse. Scroll is bounded to -2000..2000. Pixel clicks use the last returned window or zoom image's coordinates, not CSS coordinates. CUA maps the point once using the capture ID or its zoom state. The adapter rejects known page/window geometry drift before pixel input. This is not an atomic renderer-readiness or external-scroll guarantee.

`observe:false` returns a compact input outcome. By default an action returns a native image-only capture; `observe:true` also renews semantics and hints. `wait_ms` pauses after input (integer 0..5000), **not a readiness guarantee**. Arbitrary keys, coordinate pointer movement, drag, dialogs, uploads/downloads and generic overlay drawings are not exposed by this slice. No other engine or global-input fallback fills these gaps.

A refused or unknown result throws at the Pi tool boundary, stopping an awaited sequence. Earlier inputs are not rolled back. Never replay a partial sequence or an unknown launch/input. Native structured refusals count as refusals even when MCP `isError` is false.

## Native vision and human cursor

Before every overview or zoom, CUA automatically brings the exact owned browser window to the foreground. This is the user-approved compromise for covered-window paint throttling and may switch keyboard focus. Capture-free inputs and tab listing do not raise it. Results and `agent_image.foreground` record the native outcome; a failed or uncertain raise stops capture, without replay. Raising is **not a paint-readiness guarantee**.

Overview is a clean **whole-window PNG including browser chrome**, capped at 500px long edge by default. CUA uses Lanczos3; the extension does not resize pixels. `/computer-debug` shows the private loopback viewer. Its maximum-edge textbox and synchronized scale slider/exact textbox affect the next capture. Effective cap is `floor(maxLongEdge * scale)`; actual raster dimensions can round below it. Old four-kernel controls and retained-original trials are retired.

For detail, ground a rectangle in the last overview image and request:

```js
await tools.browser_observe({zoom:{x:100, y:120, width:100, height:60}});
```

CUA makes a **fresh native padded JPEG**, up to 500px wide. It is not a crop of a saved original and cannot nest zooms. Click coordinates then come from that returned JPEG. Keep window and zoom coordinate domains separate.

The human sees CUA's independent agent cursor in the actual Windows window. The Driver excludes that overlay from perception captures where supported. The cursor is not a generic rectangle/label overlay; hints are text metadata, not painted labels on the page.

Vision debug mirrors exact returned bytes, hashes, native coordinate metadata and nested action outcomes. It polls trace state, not the screen continuously. It shows the last three application-boundary images without changing the model's context. Later Pi handlers/provider processing remain unobserved; final wire delivery is unconfirmed.

**Observed limit:** native Chrome window PNGs can show an older paint than the live window and semantic snapshot, even after a pause. A successful input or matching text is not proof of current pixels. Inspect pixels and use bounded read-only observations; do not repeat input to force a repaint. The cause remains open.

## Verification and history

Read [the operating skill](../skills/owned-browser-use/SKILL.md) before browser actions. Opt-in scripts use only fresh profiles and synthetic pages:

- `node --experimental-transform-types scripts/verify-cua-adapter.mjs`: native lifecycle, four hints, refusal, input and navigation.
- `node scripts/live-cua-browser.mjs`: isolated real-model Pi through the production extension and existing Codemode.
- `node scripts/cua-browser-fixture.mjs`: disposable parent-session fixture; stop only its owned server.
- `node scripts/export-cua-preview.mjs <viewer-url> <output-directory>`: export exact retained preview assets without new input/capture.
- `node scripts/probe-cua-browser.mjs`: runtime capability/schema inspection.
- `node scripts/verify-cua-browser-native.mjs`: raw native qualification with a human-grounded zoom point prompt.

Historical Playwright, stable-DOM-hint, Sharp/MKS2021 and saved-crop results remain in Git and their linked tasks. They are not current capabilities. The unfinished LPT-372 patch was archived and read back exactly in its [Linear document](https://linear.app/alexshpunt/document/lpt-372-paused-playwright-backend-patch-before-cua-retirement-dcff0b18e49e) before removal. The game remains paused. Primary-display reading and common window/browser source metadata are described in [Observation sources](observation-sources.md). [Desktop-window and display detail](native-detail.md) use the same qualified CUA runtime but do not change browser zoom/input. Lightpanda, other platforms, display input, cache changes and Sandbox remain separate work.
