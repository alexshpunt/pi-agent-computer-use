# Visible browser results

Historical pre-CUA route. Its code, runners and dependencies were retired by LPT-396; revision-linked results remain evidence, not current API guarantees. Use [the native CUA browser contract](browser.md) for current actions, scaling and fresh zoom.

[LPT-370](https://linear.app/alexshpunt/issue/LPT-370) passed on 2026-10-03. Pi in WSL controlled a new **visible Windows Chrome** using a disposable profile and a private debugging pipe. No personal browser session was attached. The agent and human saw the same page, not separate engines or a mirror.

## Environment and boundary

- Chrome 154.0.8037.58, Windows Node 22.22.2, Linux Node 24.20.0.
- playwright-core 1.63.0, Pi 0.99.1; isolated model openai-codex/gpt-6.1-sol.
- Chrome launched headed, with a new temporary profile, `--remote-debugging-pipe` and browser sandbox enabled. No debugging port, `--no-sandbox` or `--disable-web-security`. Read-only metadata found no listener owned by its root process.
- Existing browser and Windows Node installs were used. No browser installation/update, persistent setup, permission, service, firewall or desktop-mode change.
- Browser tools are independent of IDE. The actual-window evidence used a read-only Cua Driver 0.32.0 adapter addressing only the correlated new browser window; it did not promote a desktop ref or send UI input.

## Passing checks

| Surface | What passed |
| --- | --- |
| Automated | 39 unit tests, typecheck and 3 real-Pi integration tests. Existing desktop tests still pass. Browser contracts cover scoped refs, stale/foreign/closed refusal, cancellation, no replay, startup/close ordering, pending profile cleanup and PNG forwarding. |
| Native fixed-code script | Local link → form → fill → submit → JavaScript confirmation → scroll → second tab → return. Cookie/storage markers appear after submit and are absent in the next new profile. Stale/cross-page/foreign/closed refs are refused. Cancellation after native navigation reached a held local response reports unknown and closes only the owned runtime. |
| Isolated real-model Pi | 14 browser calls, with no IDE or shell tools. The model used actual registration and original PNGs, completed the fixture, switched tabs, returned to the confirmation, checked a foreign-ref refusal and verified the second clean profile. |
| Parent Pi after reload | 18 browser calls from first open through final close. The same fixture passed; stale input and foreign/closed reads were refused, a second tab closed without closing the first, and its confirmation remained unchanged. Fresh profile markers were absent. |
| Human window | Actual Chrome window PID 57776/HWND 23465482 showed the same local URL, two tabs, input, confirmation and markers as the agent's page screenshot. |
| Human Pi viewport | `inspect_tui` captured actual Herdr pane w3GH:p1, revision203, 274×108 cells, live bottom. Tool names, refs, URL/title and confirmation were readable; no broken layout or escape output. Stock collapsed results hide inline images, while the actual Chrome window shows the site. No renderer change was needed. |

Final automated/native/model batch: `npm test && npm run typecheck && npm run test:integration && node scripts/verify-browser-native.mjs && node scripts/live-browser.mjs`, exit0. The actual-window adapter ran successfully with Node's `--experimental-transform-types` flag.

## Timing, not a general speed claim

The isolated model made 14 calls; recorded worker roundtrips totalled 10.295s, median 202ms. First and second fresh browser opens took 3.638s and 3.928s. Parent 18 calls totalled 12.161s, median 208ms; fresh opens took 4.206s and 4.407s.

These figures measure this machine and fixture. They include startup in open calls but exclude model reasoning, agent tool scheduling, user pauses and queued waiting. Close timings record the worker's response, not the subsequent parent-side process/profile verification. They are not end-to-end benchmark results or proof that every site is fast.

Actions return fresh state and PNG directly, so the agent need not observe again after each successful action.

## Evidence and cleanup

[Compact run data](evidence/browser/run.json) contains only synthetic pages, scoped refs, measured timings, owned window metadata and cleanup. Screenshots:

- [Agent confirmation](evidence/browser/parent-confirmed.png)
- [Actual owned Chrome window](evidence/browser/actual-window.png)
- [Scrolled local section](evidence/browser/native-scrolled.png)
- [Second tab](evidence/browser/parent-second-tab.png)
- [Returned first tab](evidence/browser/parent-returned.png)
- [New clean profile](evidence/browser/parent-clean-profile.png)
- [Actual Pi viewport](evidence/browser/parent-viewport.png)

Final read-only cleanup found browser roots 0, Windows workers 0, disposable profiles 0 and no owned listeners. The parent's fixture server exited0 and its URL was no longer reachable. Both browser sessions closed; the read-only capture adapter released its Driver. No personal process or all-browser kill was used.

## Failures found and fixed

An early client test accidentally used a real worker before launcher injection existed. Its process/browser exited, but a profile remained. That exact inactive owned profile was removed after a process check. Parent lease tracking and cleanup regressions now prevent false cleanup success or a new launch while cleanup is unresolved.

A completed input followed by observation failure originally looked like pre-input refusal. A red/green regression now requires unknown, so partial effects are not misrepresented or replayed.

The actual-window test adapter initially omitted Node's transform flag and passed a string HWND to a numeric Driver field. Those test setup failures happened before UI input; the corrected read-only capture passed. Failed or preliminary runs are not exported as final success evidence.

## Limits

A new profile separates browser data; it is **not an OS sandbox**. Host filesystem/network permissions and focus non-interference are not isolated or guaranteed. Existing user-selected Safe/YOLO stays intact; these browser tools still use only their owned profile under either mode.

Only Chrome and local synthetic pages were qualified live. Edge fallback, other engines/platforms, general sites, rich accessibility/iframe/shadow-root coverage, dialogs, login, uploads/downloads, persistent profiles and multi-agent pooling are not claimed. Bounded top-level DOM semantics and viewport screenshots are separate captures, not an atomic snapshot of a dynamic site.

Lightpanda was not installed or integrated: its current text renderer does not satisfy the user's chosen visible real-site requirement. Sandbox and IDE integration remain deferred.
