# What we learned from Codex Computer Use

Historical comparison. The inspected source notes remain useful, but the proposed DOM registry/overlay below is not the current implementation. LPT-396 uses native CUA snapshots and cursor; see [the current contract](../browser.md).

Checked on 2026-10-03 after the user's side-by-side game test. This is an implementation comparison, not a claim that our agent performs as well as Codex.

## Sources actually inspected

The installed Windows plugin cache contained OpenAI bundle version `26.930.31730`. We read its files, without starting its runtime, connecting to its private pipe, or reading its browser sessions.

Under `%USERPROFILE%/.codex/plugins/cache/openai-bundled/`:

| File, relative to plugin/version | SHA-256 |
| --- | --- |
| `computer-use/26.930.31730/skills/computer-use/SKILL.md` | `8211e4b11a19a0dc4f0ace91096c74c5b36037ca4cb2c8988f0f535bb209e951` |
| `computer-use/26.930.31730/docs/guidance.md` | `b171b26bc19f49226bb594bf3ed3f36666e5dd063a996c297986b2b461ac8efd` |
| `browser/26.930.31730/docs/api-use-behavior.md` | `b68e472c3e85fa8a6e71b7ca6f03d5c62ee795d6272e3bdb0872f38ad1ac9156` |

The unified runtime is `cua_node/45309f9050f7314b`, with `@oai/cua` version `0.2.5`. Under that package:

| File | SHA-256 |
| --- | --- |
| `docs/tinysky-alt-core-cua-repl.md` | `0a08dbe6ce18cadb55215be30ebbba9afd6195a7333023795424ef6aee2ad148` |
| `dist/lib/js/oai_js_cua/src/tinysky_alt/bind_tab.js` | `df87395f8a0c317a051f68657af79acccc84905b5c825e8f9c63ec8a797de2db` |

Public context:

- [Codex CLI source and scope](https://github.com/openai/codex): its README identifies the CLI and links separately to the desktop app.
- [Public repository license](https://github.com/openai/codex/blob/main/LICENSE): Apache-2.0 does not by itself establish the license of every installed desktop plugin.
- [Bundled skill packaging report](https://github.com/openai/codex/issues/41903): names the Browser, Chrome and Computer Use packages and documents the distinction between public repository files and bundled app assets.
- [Windows unified-runtime issue](https://github.com/openai/codex/issues/42745): reports that native Sky and browser surfaces have separate service configuration. This is supporting context, not proof of all backend internals.

We did not find a redistribution license in the inspected `@oai/cua` package metadata. The project skill is therefore an original adaptation of the workflow, not a verbatim vendor-skill copy. No OpenAI helper or package was installed or vendored.

## The important distinction

There is not one universal Computer Use backend.

The Windows-specific skill initializes `@oai/sky`. It describes SendInput, UI Automation and Windows.Graphics.Capture. That does **not** identify it as the Cua AI Driver used by this project. Similar names are not evidence of shared implementation.

The unified skill presents a persistent JavaScript interface for both apps and browser tabs. The installed tab wrapper dispatches to `tab.ax` when available. When it is absent, observation uses `tab.playwright.domSnapshot()` and `tab.screenshot()`; native input wrappers refuse and instruct the caller to use Playwright. We inspected that dispatch, not the entire native or browser-service implementation. The screenshot supplied by the user cannot establish which path handled that particular game run.

The unified skill is the closer match to the requested browser workflow than the older Windows-only two-cell loop. It explicitly supports several deterministic actions followed by one observation in the same JavaScript call.

## Workflow differences worth adopting

| Codex guidance | Our adaptation |
| --- | --- |
| Keep app/tab handles in persistent JavaScript state | Focus the owned tab once; keep short hints in Pi Codemode |
| Batch known actions, then read the state at the next decision point | `observe:false` for intermediate actions, final image/full observation |
| Choose the cheapest observation that answers the next question | PNG-only input response by default; explicit full text/target discovery |
| Do not repeat an unchanged observation without missing context | Inspect the existing result before requesting another full read |
| Avoid navigation to the same URL merely to refresh | Recover the owned tab rather than resetting game progress |
| Confirm the actual result, not merely successful input dispatch | Read visual changes before Verify; separate reasoning failure from input failure |
| Bound state and handle lifetime; recover rather than guessing | Same DOM node retains its hint; new nodes get new hints; no stale-target rebinding |
| Avoid unnecessary fixed waits | Use bounded waits only for an observed transition; no blanket half-second pause |

Codex's unified docs also describe automatic observation emission, AX diffs on supported surfaces, richer text/key/drag actions and platform-specific waits. Those are not all implemented here. Pi Codemode needs explicit `image(view.image)` forwarding. Our compact input is serial, not an animation-readiness promise. We have no evidence that copying more API names would improve performance.

The project retains its stricter owned-browser boundary. It does not import Codex's ability to bind personal Chrome tabs, broad native input, or private service configuration.

## Measured input comparison

The synthetic rotation fixture received 16 Playwright clicks: four with full observation, four with image-only output, four screenshot-coordinate clicks, and four compact same-hint clicks. All 16 were counted once. The document token stayed constant and the overlay root was added once. The original hint remained `a`.

Four additional Cua background coordinate clicks on the same fixture were grounded in its real window screenshot. All four were counted once. Cua did not expose the tile in its accessibility elements, so no semantic-input result is claimed.

In that one run:

- Playwright coordinate input: about 2–3 ms; following PNG: 72–89 ms.
- Playwright hint input: about 29–66 ms in the repeated-click samples.
- Full semantic observation work: about 15–40 ms for this small fixture.
- Cua scoped coordinate input: about 109–161 ms; native window observation: 320–649 ms.

These are different capture surfaces and a small local fixture, not a general speed ranking or a timed Codex comparison. They do not support replacing the browser backend with Cua to fix hint churn. Hint churn was our observation/identity design, not a page reload.

## Anthropic comparison

The current [Browser Use tool documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool), checked on 2026-10-03, describes a client toolset: the application supplies its own browser executor. It is not evidence for a specific hidden native driver. It supports sequential batches and requires stopping remaining actions after the first failed action, which matches our awaited Codemode failure boundary.

Its screenshots and coordinate actions share viewport coordinates. Its `zoom` is a cropped, enlarged observation, not a change to browser page zoom. This is a useful distinction for a future inspection capability: do not silently change page layout just to read a small region.

The user has now made completing the full game the final acceptance goal. Continue beyond Level 5, add missing browser input capabilities when an observed task needs them, and verify each addition end-to-end. Do not count a difficult puzzle as an input-tool blocker. Browser ownership and the ban on hidden-state solutions remain unchanged.
## Verification still needed

The adapted [owned-browser-use skill](../../skills/owned-browser-use/SKILL.md) must be exercised after Pi reload, with actual TUI inspection and the live game restored to Level 5 if necessary. A better API and passing fixture do not prove equal game-solving ability. Record the observed game outcome and remaining tool gaps separately.
