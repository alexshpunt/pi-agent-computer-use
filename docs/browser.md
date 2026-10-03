# Visible agent browser

The standalone extension has five browser tools in addition to the six desktop tools. Pi in WSL controls its own **visible Windows Chrome/Edge** through Windows Node and Playwright. The browser window shows the same page that the agent reads and changes. It is not a second browser or a screenshot viewer.

[LPT-370](https://linear.app/alexshpunt/issue/LPT-370) passed native, isolated real-model Pi and live parent checks. See [the results and limits](browser-results.md).

## Setup

Use the existing project-local extension and install its declared dependencies. No separate browser extension, account or per-window config is needed.

The current path requires Windows Node at `C:\Program Files\nodejs\node.exe` when Pi runs in WSL, plus an installed Windows Chrome or Edge. It tries Chrome in Program Files first, then Edge in Program Files (x86). Missing programs are refused, never installed automatically. The tested runtime is Windows Node22.22.2 and Chrome154.0.8037.58 with playwright-core1.63.0. Other installations and Edge have not been qualified live.

First `browser_open` starts an owned worker and a headed browser with a new temporary profile. Control uses stdio and Chromium's private debugging pipe, with **no debugging port**. The browser sandbox stays enabled. The launch uses explicit options instead of Playwright defaults that disable some browser security checks.

## Tool flow

1. `browser_open({url})` opens an HTTP(S) URL in a new owned tab and returns its first observation.
2. Read its URL, title, text, element names/roles and original viewport PNG.
3. `browser_act` uses the current `page_ref`, `observation_id` and, for element input, `element_ref`. One action returns a fresh observation and PNG.
4. `browser_tabs({})` lists only this owned session. `browser_observe({page_ref})` selects a listed tab in the actual window and reads it again.
5. `browser_close({})` closes the entire owned browser and worker, deletes its profile and discards all refs. Opening later starts a clean profile.

Actions: `click`, `fill`, `press`, `scroll`, `navigate`, `close_tab`. Fill replaces the input value. Press supports Enter, Tab, Escape, Backspace, Delete and the arrow keys. Scroll accepts `delta_y` within -2000..2000. Navigation requires HTTP(S) without embedded credentials. Closing a tab returns the remaining tabs, not a page screenshot.

The model cannot supply selectors, arbitrary JavaScript, executables, profile paths or a personal debugging endpoint. Site content is untrusted data, not instructions.

## References and outcomes

Each tab has its own latest observation. Reading one tab does not invalidate another's refs. Dispatch consumes the targeted observation; never reuse it, even after a failed action. Main-document navigation and removed element handles also invalidate native targets.

- `observed`: fresh page state and original pixels.
- `listed`: current owned tabs.
- `closed`: owned cleanup or tab closure completed.
- `refused`: input was rejected before dispatch.
- `unknown`: an open/action may have partly run, or cleanup needs attention.

After unknown input, discover fresh tabs/state before deciding. Never blindly replay or open another copy. Cancellation and connection loss end the owned pipe; the worker closes its own browser. A failed profile cleanup remains pending and blocks a new launch rather than pretending success.

## Boundaries

The profile starts without personal cookies, saved passwords, extensions, accounts or tabs. Close discards its storage. This is **browser-data separation, not OS isolation**: the browser and worker still run as the Windows user with normal host permissions and network access.

Browser ownership is separate from desktop Safe/YOLO. These five tools never adopt personal tabs, even under YOLO, and cannot change mode. Selecting a tab may activate its window; there is no focus non-interference guarantee. The fixture flow uses page-scoped input, not global host keyboard/mouse input.

Observations contain bounded top-level DOM text and up to 120 actionable elements, plus a real viewport screenshot. They are not a complete accessibility tree or iframe/shadow-root API. Dynamic pages can change between semantics and screenshot capture. Native dialogs are dismissed; dialog automation, login, uploads/downloads, persistent profiles, other engines/platforms and general website compatibility remain outside this slice.

Lightpanda remains a possible later headless backend. Its current text-only PNG/PDF renderer cannot show an ordinary site's visual layout, so it is not used here.

## Verification scripts

All native scripts are opt-in and use new profiles and synthetic loopback pages:

- `node scripts/verify-browser-native.mjs`: grounded local actions, stale/foreign refusal, new clean profile, cancellation and owned cleanup.
- `node scripts/live-browser.mjs`: real-model isolated Pi with only the five browser tools, no IDE or shell.
- `node scripts/browser-fixture.mjs`: local fixture for the parent Pi session; its exact URL is printed and recorded under `.tmp`. Stop only this owned server after verification.
- `node --experimental-transform-types scripts/capture-browser-window.mjs`: read-only actual-window screenshot when exactly one known owned browser is active. This test adapter is not a policy-changing tool.

Synthetic markers check cookie/storage separation; they do not audit every kind of browser data. Timing is measured per tool call, not promised as a universal speed improvement.
