---
name: computer-use
description: Control permitted Windows apps and the agent-owned browser through Pi Codemode and Cua Driver. Use for reading UI, navigating, clicking, typing, scrolling and inspecting overview or zoom images. Read before computer-use work or declaring a UI capability unavailable.
compatibility: Pi with pi-agent-computer-use on Windows/WSL and its qualified Cua Driver runtime.
metadata:
  source: Installed Codex unified Computer Use instructions, bundle 26.930.31730, @oai/cua 0.2.5
---

## Computer Use

Control native apps and browsers on the user's computer by reading or operating UI. Prefer purpose-built connectors, APIs, or CLIs when available, unless the user explicitly requests a visible UI benchmark.

This is the user-requested minimal working adaptation of the full Codex unified instructions. The [complete unchanged source](references/codex-unified-original.md) is preserved for comparison, not execution. Its SHA-256 is `0a08dbe6ce18cadb55215be30ebbba9afd6195a7333023795424ef6aee2ad148`. API names, parameters, output handling and platform claims differ where Pi's actual contract requires it. No `@oai/cua`, `@oai/sky`, `cua_repl` or compatibility runtime is installed here. The inspected bundle had no established redistribution license; do not assume the public Codex repository's license covers these bundled assets or include them in a public release without review.

Read [the owned-browser skill](../owned-browser-use/SKILL.md) before browser tools and [capability gaps](references/capability-gaps.md) before planning missing operations. Project permissions and safety rules still apply; this skill does not grant new access.

- Use existing Pi `codemode` JavaScript for all UI action sequences.
- Do not use other technologies for computer interactions: no Playwright, raw CDP, page JavaScript, shell-driven UI, OS-global input or another capture/input backend. CUA is the only backend; missing capabilities belong in the adapter above the unmodified Driver.
- Prefer a dedicated connector or skill when it can complete the requested task; use Computer Use for interactions not exposed through a more specific interface.
- Codemode's JavaScript variables do not persist across calls. Use `store(key, value)` and `load(key)` for returned JSON values. Do not store invented handles, reuse consumed desktop observations or assume hints survive a new semantic snapshot.
- Opening an owned browser or a new installed app returns the initial UI state. In Codemode, forward returned image and text explicitly.

## API

Use the actual tool schema as the source of truth. The following map replaces Codex's app/tab objects, not the tools themselves. There is no unified `Target` object and no additional executor.

| Original operation | Actual Pi operation / boundary |
| --- | --- |
| `cua.getState()` | `computer_apps`, `computer_windows` and `browser_tabs` are separate inventories; no combined State |
| `cua.listApps()` | `computer_apps({query?})`, installed Windows app discovery, no launch |
| `cua.listWindows()` | `computer_windows({query?})`, permitted returned window refs |
| `cua.computer.launch_app()` | `computer_open({app})`, genuinely new window, not reuse |
| `cua.getApp()` | Select an exact returned `window_ref`; observe through `computer_observe` |
| `cua.getBrowser()` | No personal/existing browser binding; use the owned browser only |
| `cua.createBrowserTab()` | `browser_open({url})` opens one new isolated browser, not an extra tab |
| `cua.getTab()` | `browser_focus({tab})` selects the single active owned working surface, not tab activation |
| `cua.listBrowsers()` | No desktop-wide browser inventory/binding operation |
| `cua.listTabs()` | `browser_tabs({})`, owned tabs only |
| `getAXState()` / `getAXStateAndScreenshot()` | Browser `browser_observe({})`; window `computer_observe({window_ref})`, both return text+PNG; no AX-only or diff option |
| `getScreenshot()` | Browser `browser_observe({image_only:true})`; window observe still includes its tree |
| `click(index)` / `click([x,y])` | Browser `browser_act({click:hintOrPoint})`; window `computer_act` with latest observation and element token or point |
| `setValue(index,value)` | Browser `browser_act({fill:hint,text})`; window `computer_act({action:'set_value',…})` |
| `typeText()` | Window `computer_act({action:'type_text',…})`; browser fill replaces a value, not append/keystroke typing |
| `pressKey()` | Window `computer_act({action:'key',key,…})`, limited key enum only; arbitrary browser keys/chords unavailable |
| `scroll()` | Browser `browser_act({scroll:{hint,delta_y}})`; no current desktop scroll, point/page-count scroll or horizontal option |
| `goto(url)` | `browser_act({navigate:url})` |
| `close()` | `browser_close({})` closes the whole owned browser; `computer_close({})` releases refs/runtime, not app windows |
| `drag`, `selectText`, `performSecondaryAction`, formatted `paste`, back/forward/reload, tab lifecycle markers | No equivalent public Pi operation; see capability gaps |

Browser call shapes:

```typescript
// These are calls to existing tools, not a wrapper or an import.
await tools.browser_open({ url: "https://example.org" });
await tools.browser_tabs({});
await tools.browser_focus({ tab: 1 });
await tools.browser_observe({});
await tools.browser_observe({ image_only: true });
await tools.browser_observe({ zoom: { x: 100, y: 120, width: 100, height: 60 } });
await tools.browser_act({ click: "a", observe: false });
await tools.browser_act({ click: { x: 150, y: 140 } });
await tools.browser_act({ fill: "b", text: "Hello", observe: false });
await tools.browser_act({ hover: "c", observe: false });
await tools.browser_act({ scroll: { hint: "c", delta_y: 600 }, observe: false });
await tools.browser_act({ navigate: "https://example.org" });
await tools.browser_close({});
```

The hints/points above illustrate syntax only. Replace them with values grounded in the current actual observation. `observe:false` returns compact input outcome; default returns image-only capture; `observe:true` renews semantics and returns PNG. `wait_ms` permits 0..5000, but is a pause, not readiness. Fill text is bounded to 4000 characters; vertical scroll is bounded to -2000..2000.

Window and display call shapes:

```typescript
await tools.computer_apps({ query: "Calculator" });
await tools.computer_open({ app: "Calculator" });
await tools.computer_windows({ query: "Calculator" });
await tools.computer_observe({ window_ref: "returned-ref" });
await tools.computer_observe({ window_ref: "returned-ref", query: "returned label" });
await tools.computer_act({
  window_ref: "returned-ref", observation_id: "latest-id",
  action: "click", element_token: "returned-token"
});
await tools.computer_act({
  window_ref: "returned-ref", observation_id: "latest-id",
  action: "type_text", element_token: "returned-token", text: "Hello"
});
await tools.computer_act({
  window_ref: "returned-ref", observation_id: "latest-id",
  action: "key", key: "return", element_token: "returned-token"
});
await tools.computer_observe({ display: "primary" });
await tools.computer_observe({
  display: "primary",
  zoom: { image_id: "latest-image-id", x: 100, y: 80, width: 100, height: 60,
    maxLongEdge: 1200, scale: 1 }
});
await tools.computer_close({});
```

Choose exactly one `window_ref` or `display`. Display reads require user YOLO mode and task authorization; Safe forbids them. `query` is window-only and cannot combine with zoom. Display/window detail uses the latest overview `agent_image.image_id`, cannot nest and cannot ground input. Window detail has native padded JPEG/500px width; display detail crops a fresh full-resolution CUA capture, with an optional bounded cap/scale. Browser zoom is different: it takes the last overview rectangle without an image ID and can ground one browser point click.

Window actions use `type_text`, `set_value`, `click`, `select_all` or `key`. The supported keys are `backspace`, `delete`, `left`, `right`, `home`, `end`, `return`, `escape`, `tab`. Literal text is bounded to 2000 characters. Each dispatch consumes the desktop observation, even on failure.

Codex's MCP App tabs, DOM-only fallback, personal Chrome binding and optional Playwright locators have no equivalent here. Refuse an unsupported operation rather than importing that fallback. Browser image work requires exactly one active owned tab; do not guess a tab ID or claim `browser_focus` activates one.

## Native apps

This adapter is live-qualified on Windows/WSL. Select the target from returned `computer_apps` / `computer_windows` results; never reconstruct an app or window from guessed fields. If several windows match, choose the requested returned window by app/title. Do not silently choose the first one.

Use `computer_windows` to inspect permitted open windows or recover a known app. If the user asks for a new disposable app window, discover its exact installed name/app_id and call `computer_open` once. It must return a genuinely new window. Unknown launch requires discovery, not another blind open. Explicit executable paths and arbitrary shell launches are not supported substitutes.

Safe permits only session-opened windows. YOLO permits discovery/actions on other windows, but does not authorize unrelated documents. Only the user changes mode. Neither policy is OS isolation.

Window input is background by default; it does not promise app repaint or a verified site effect. Request foreground delivery only after an observed failure/refusal and only for the exact authorized target. Unknown delivery may have changed the app; reobserve before deciding. Do not blindly retry. Native apps can create modals or another window; discover and identify that returned target before observing/acting.

The owned browser is a separate surface. Each overview or zoom raises only its exact owned window and may switch keyboard focus, by the user's approved policy. Capture-free input does not raise it. CUA handles overview/zoom coordinates once. A pixel click requires a fresh returned image and unchanged known page/window geometry; capture-free pixel input consumes that context.

Codex's macOS app launch, Linux window binding, X11/AT-SPI behavior, Windows Sky activation and screenshot mapping are source-specific, not promises of this adapter. Keep them in the unchanged reference and capability list until each platform has live qualification.

## Workflow

After one or more supported browser UI actions, call `browser_observe({})` before deciding what to do next. This renews semantic hints; use the fresh returned hints rather than reuse stale ones. Image-only capture does not renew hints. After desktop input, `computer_observe` is required for a new observation before another action.

Current Pi observations return full semantics/tree, not Codex's AX diffs. There is no `disableDiffing` switch. Desktop `query` projects matching labels/values and ancestors; it does not create an AX-only or text-selection API. Browser screenshot-only observations preserve current hints, but do not prove the page tree is unchanged. Refresh semantics when the task needs current targets.

Minimize model and tool round trips while retaining fresh UI state:

- Batch deterministic browser hint actions and their final observation into one awaited Codemode call. Desktop dispatches and pixel actions need their own fresh grounding; do not apply the browser hint batch rule to them.
- `browser_open` and `computer_open` return initial observations. Forward text/image explicitly in Codemode; no `getApp`/`getTab` binding or automatic emission exists.
- An owned blank/new-tab page is not permission to bind a personal tab. Navigate only the owned browser to an allowed URL.
- If an observation shows no change, do not immediately repeat it without missing context. Use image-only or a grounded zoom when it answers a specific question. If pixels and semantics disagree, bounded read-only reobservations are allowed; do not repeat the input to force agreement.
- Prefer a directly relevant result already visible in the current state over opening broader intermediate UI such as “Show All.”
- Once the requested result is visibly present, stop exploring and respond. In a user-requested game run, a passed level is an intermediate result; continue until the user's goal, pause or a concrete blocker.

Perform supported known actions, then fetch the latest state:

```javascript
// Use hints actually returned by the previous observation.
for (const hint of ["a", "b", "c", "d"])
  await tools.browser_act({ click: hint, observe: false });
const view = await tools.browser_observe({});
text(view.text);
image(view.image);
```

```javascript
// Desktop: use refs/tokens from its latest observation, then observe again.
const result = await tools.computer_act({
  window_ref: "returned-ref", observation_id: "latest-id",
  action: "set_value", element_token: "returned-token", text: "Hello"
});
text(result);
const view = await tools.computer_observe({ window_ref: "returned-ref" });
text(view.text);
if (view.image) image(view.image);
```

These are syntax examples, not replayable targets. Check desktop structured `status` before input; refusal can be returned as data. Browser refused/unknown outcomes throw at the tool boundary and stop an awaited sequence. Earlier inputs are not undone. Do not replay a whole partially completed sequence.

Codex's `selectText`, formatted paste, secondary actions, browser key combinations and dragging remain unavailable. Do not replace them with a normal click or whole-field fill and claim equivalent behavior.

## Output

- For text output, use `text(...)`. It accepts strings or JSON values; do not print base64 image data as text.
- For image output, use `image(view.image)` on the actual returned image block. PNG and JPEG are supported returned formats. Do not emit a source/original image that the task did not authorize.
- Tools called inside Codemode do not automatically forward their images to the model. Forward what the next decision needs; do not duplicate text/pixels already available in the current result without a reason.
- Browser observation results expose `text`, `elements`, optional `image`, `agent_image` and `source`. Desktop `computer_observe` has structured text/image/source, while other desktop tools may return readable text rather than a structured object. Inspect the actual result shape; do not invent Codex-style app objects.
- Use `store`/`load` only for returned values, not a persistent browser runtime. Observe again after reload, reopen or consumed desktop input. A stale saved observation is not authority for input.
- Native PNG/JPEG output is a point-in-time observation. The local debug viewer mirrors exact bytes and metadata, not a continuous screen recording or a final-provider-wire guarantee. Its three cards do not evict images from Pi context.

## Notes

- Browser fill targets a fresh hint and replaces the text value. It is not `typeText`, formatted paste or keystroke events into whichever field currently has focus. Desktop literal typing needs its latest grounded observation; inspect focus/target before sending it.
- Prefer semantic actions when a current reliable target exists. Use screenshot coordinates when semantics do not identify the target. After explicit refusal, observe before choosing another supported route; unknown is never a reason to repeat input blindly. There is no DOM-only Playwright fallback.
- Codex macOS paste uses/restores its pasteboard; browser paste does not restore it. Those source-specific behaviors are not available here. Literal Pi text/fill does not claim clipboard ownership, restoration or Markdown/HTML paste support.
- Browser scroll uses a returned hint and signed vertical pixels, not a page count or a coordinate target. Desktop scroll is not currently exposed. Do not pretend Codex Linux/macOS scroll shapes work on this Windows adapter.
- Arbitrary text-span selection and cursor placement are unavailable. Desktop select_all sends Ctrl+A; it is not `selectText`. Window set_value may refuse when the native element cannot support it; inspect the actual effect.
- If the UI is not behaving as expected, fetch a fresh observation and inspect current text and pixels before deciding.
- Secondary accessibility actions must be exposed by a fresh tree before a future adapter dispatches them. Do not guess Expand/Increment/Cancel actions or invoke arbitrary action names with the current schema.
- Codex selection prefix/suffix and `selectionType` semantics remain in the source reference; no current Pi equivalent is advertised.
- Pi's limited desktop `key` enum is not Codex xdotool-style key/chord syntax. Do not send `super+c`, `KP_0` or arbitrary strings. Browser arbitrary keys/chords are unavailable.
- App launch follows installed Windows discovery and exact new-window identity. macOS display names/bundle IDs and Linux app launch behavior are not qualified here.
- A native capture or foreground raise does not guarantee paint readiness. Do not add a fixed delay before every observation. Use bounded pauses only when the observed transition needs them; repeated input is not a repaint strategy.

Persist until the request is fully completed end-to-end. Attempting an action is not completion: verify that the returned UI state visibly shows the requested result. If an action leaves the state unchanged, produces no results, or only reaches an intermediate page, inspect the outcome and try another supported approach. Respond only after the requested page, information, or state is visibly present, or explain a concrete blocker you cannot resolve. Stop when the user interrupts or pauses the task.
