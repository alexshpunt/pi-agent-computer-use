# Visible agent browser

Six browser tools control an **owned visible Windows Chrome/Edge** from Pi in WSL. Windows Node runs Playwright through a private stdio connection. The human sees the actual agent browser, not a mirror or a screenshot viewer. There is no Pi Agent IDE dependency.

The first browser slice passed [LPT-370](https://linear.app/alexshpunt/issue/LPT-370); its [report](browser-results.md) is historical. [LPT-372](https://linear.app/alexshpunt/issue/LPT-372) adds a focused surface, short labels and compact actions in existing Pi Codemode.

## Setup

Use the project-local extension and its declared dependencies. No browser extension, account or per-window config is needed.

WSL requires Windows Node at `C:\Program Files\nodejs\node.exe`, plus installed Chrome in Program Files or Edge in Program Files (x86). Chrome is tried first. Missing programs are refused, never installed automatically. Windows Node22.22.2, Chrome154.0.8037.58 and playwright-core1.63.0 were tested; Edge and other installations have not been qualified live.

First open creates a worker and a headed browser with a new temporary profile. Control uses Chromium's private debugging pipe, **not a debugging port**. The browser sandbox stays enabled. Launch options do not disable browser security checks.

## Focus once, then work

- `browser_open({url})` opens **and focuses** a new owned tab, returning text, short hints and a labelled PNG.
- `browser_tabs({})` lists owned tabs with small numbers and their focus state. It does not change focus.
- `browser_focus({tab:1})` selects an owned tab in the real window and returns its working surface.
- `browser_act({click:"a"})` acts in that surface. No page, observation or long element IDs are needed.
- `browser_observe({})` refreshes the focused page after a sequence. It replaces old hints.
- `browser_close({})` closes the entire owned browser/worker and deletes its profile. Opening later starts with clean storage.

Each act takes exactly one action:

```js
{click:"a"}
{fill:"b", text:"Hello"}
{press:"b", key:"Enter"}
{scroll:600}
{navigate:"https://example.org"}
{close_tab:true}
```

Fill replaces a value. Press supports Enter, Tab, Escape, Backspace, Delete and arrow keys. Scroll is bounded to -2000..2000; navigation requires HTTP(S) without embedded credentials.

Actions return a compact **input outcome**, not a fresh screenshot. `observe:true` requests immediate full state. `wait_ms` requests a pause after input (integer0..5000, default0, not allowed on close_tab). A pause is not a page-ready guarantee.

## Existing Pi Codemode

Use labels from the current working surface, not invented labels. For example, if it shows four choices labelled `a`, `b`, `c`, `d`:

```js
for (const hint of ["a", "b", "c", "d"])
  await tools.browser_act({click:hint});
const view = await tools.browser_observe({});
text(view.text);
image(view.image);
```

This is one model/tool exchange, four serial page inputs, and one final capture. It does not send arbitrary code to the site. Pi already supplies the Codemode executor; this extension adds no second executor.

Tools declare structured results. Codemode receives the state directly, including `elements`, `tabs` and the optional `image` block; there is no need to parse tool prose or print base64. Use `image(view.image)` to send a captured PNG to the model. Refusal or unknown input **throws** at the Pi tool boundary, so an awaited sequence stops there. Completed actions are not rolled back. Observe before deciding what to do next; do not replay a partly completed sequence.

## Hints and screenshots

Short lowercase sequences (`a`..`z`, `aa`..) identify saved DOM handles, never selectors. The list and visible yellow labels use the same allocation. Observe/focus replaces those hints; labels are not reused across captures, focus changes, close/reopen or worker replacement. Only the allocation counter is saved in Pi session history for reload recovery, not browser ownership or DOM handles. Labels grow with a long session; they are whole tokens, not a prefix-free keyboard command language.

Within a working surface, several short-hint clicks/fills/presses can use the same saved handles without recapture. Main-document navigation, removed/hidden targets and closed tabs refuse known stale input. A handle is never looked up again by selector and rebound to a replacement node. Dynamic pages can still change between validation and input; an uncertain outcome is reported as unknown.

For canvas or a target missing from the list, use `{click:{x:150,y:140}}` from the **latest** PNG. Pixels are viewport CSS pixels measured from the top-left; dimensions are in `screenshot.width/height`. A complete in-bounds point is required. After any dispatched input, another coordinate click needs a new observation. A changed viewport, scroll position or zoom also refuses stale coordinates. Pinch zoom is unsupported.

The non-intercepting label overlay appears in the real page and PNG. Labels describe the last capture; they are not a continuously tracked live map. Observe again when the page layout changes. The overlay can alter a site's DOM or visual composition; no claim is made that every site tolerates it unchanged.

## Outcomes and recovery

- `observed`: fresh page text, hints and pixels.
- `acted`: input finished; its intended site effect is not yet verified.
- `listed`: owned tabs.
- `closed`: owned cleanup or tab closure completed.
- `refused`: the operation was rejected before input.
- `unknown`: input/open may have partly run, or cleanup needs attention.

Open retries a refused capture once on the same tab, never repeating launch or navigation. If capture still fails, its known tab remains focused and its number is included when available. Observe the focus, or list owned tabs if necessary; never open a duplicate blindly.

Scroll/navigation requires a fresh observation before more input. Refused/unknown native dispatch retires the working observation. Cancellation and connection loss end the owned pipe; the worker closes its browser. A failed profile cleanup stays pending and blocks a new launch rather than claiming success.

## Boundaries

The disposable profile has no personal cookies, passwords, accounts, extensions or tabs. Close discards its storage. This is **browser-data separation, not OS isolation**: the browser and worker run with normal Windows user permissions and network access.

These browser tools never adopt personal tabs, even under desktop YOLO, and cannot change Safe/YOLO. Selecting a tab may activate its window; there is no focus non-interference guarantee. Input is page-scoped, not global host keyboard/mouse input. The model cannot supply selectors, page JS, executables, profiles or a personal debugging endpoint. Site content is untrusted data, not instructions.

Observations contain bounded top-document text and up to120 viewport targets. Heuristics include native controls, common roles, onclick/jsaction/tabindex and pointer-cursor leaves from up to8000 DOM nodes. They are not universal custom-widget detection, a complete accessibility tree, or an iframe/shadow-root API. Native dialogs are dismissed. Login, uploads/downloads, persistent profiles, other engines/platforms and general site compatibility remain outside this slice.

Lightpanda remains a possible later headless backend, not the visible backend used here.

## Opt-in verification

Native scripts use only new profiles and synthetic loopback pages:

- `node scripts/verify-browser-focus.mjs`: four custom short-hint clicks, labels, compact outcomes, form input, removed/navigation/foreign-hint refusal and worker-reopen cleanup.
- `node scripts/verify-browser-click.mjs`: coordinate bounds, explicit wait, stale-scroll refusal and cleanup.
- `node scripts/verify-browser-native.mjs`: storage, tabs, stale/foreign refusal, cancellation and cleanup.
- `node scripts/live-browser.mjs`: isolated real-model Pi with only browser tools and existing Codemode, no IDE/shell.
- `node scripts/browser-fixture.mjs`: parent-session fixture; exact URL is printed and recorded under ignored `.tmp`. Stop only this owned server.
- `node --experimental-transform-types scripts/capture-browser-window.mjs`: read-only window capture when exactly one marked owned browser exists; no policy promotion.

Markers check cookie/storage separation, not every kind of browser data. Fewer captures or model exchanges are not a measured speed score.
