# Complete CUA input results

LPT-383–385 use the user-approved complete-gesture scope, not the original held-input scope. Verification used the unchanged Windows CUA 0.33.2 from Pi in WSL. No separate browser input tool, backend, dependency, machine setting or driver patch was added.

## What passed

- 152 unit tests, typecheck and ten real-Pi tests passed. Regression checks cover native field projection, zero-input invalid batches, the elapsed admission budget, partial/refused/unknown prefixes, cancellation, Safe access and window lifetime loss. The real Pi/Codemode test also checks the native call log: no intermediate captures or replay.
- The standalone native run made 63 calls, kept 18 records and witnessed 65 application events. It verified physical key-down/up pairs, a Shift chord and release, literal text, right-click/contextmenu, double-click, native token scroll and three independent straight strokes.
- After reloading the production extension, the parent Pi used only the six computer tools through Codemode, with stored compact references. Its keyboard batch completed 5/5 in 7924 ms. An earlier background refusal attempted one step and completed zero; explicit foreground used a fresh overview. There was no adapter retry or completed-prefix replay.
- The parent drawing batch completed 3/3 in 3017 ms. The canvas received three distinct Pointer Event down/up pairs with released buttons between segments. The final native 318x500 PNG visibly contained the triangle and `Strokes: 3`. Application events also confirmed the keyboard effect and positive scrollTop.
- The actual Herdr viewport showed readable counts/timings and the unchanged YOLO footer (pane w3E9:p7, revisions 1288 and 1294). Stock collapsed results hide extra lines and images; this is not a claim of inline image rendering. Some nested IDE read presentations exposed their internal envelope; the IDE was not changed.
- The disposable browser window/profile/server closed. Independent read-only Windows inspection found the owned window/browser absent, Driver 0, helper 0, fixture profiles 0 and Driver profiles 0. The paused game was untouched. The user's overview settings were restored through the viewer controls and observed as 1024/1.

[Redacted measured evidence](evidence/complete-input/run.json) contains counts, relative times, image hashes and cleanup metadata. Private pixels, native text, URLs and identities are not published.

A separate disposable parent fixture completed three more independent strokes, then a read-only native 500x215 JPEG detail showed the triangle. No input was grounded from that detail. [Detail metadata](evidence/complete-input/detail.json) records its exact hash, region, release checks and zero-owned-runtime cleanup.

## Native limits found during qualification

**Pixel scroll is not exposed.** CUA 0.33.2 treated resized-image scroll coordinates as unscaled offsets in the foreground path. A delivered receipt produced no expected scroll event. The adapter now refuses point scrolling before any native call; use a current observed element token. This restriction has a red-to-green regression check. Native token scroll passed. In the parent run, background scroll refused; the explicit foreground request then succeeded through native UIA, whose receipt reported background delivery. Requested and native delivery are not the same field.

Right/double click require the driver's flat pid/window_id arguments, unlike its shared typed-target tools. The adapter uses that public contract, protected by mapping tests.

Native background drawing uses synthetic pointer injection. The application observed `pointerType: touch`, not ordinary mouse drags. The fixture therefore handles real Pointer Events and pointer capture; mouse-only handlers did not establish a drawing effect. No page script injects input or draws the test shape on the agent's behalf.

Physical letter keys follow the active OS keyboard layout. Literal text uses type_text; the adapter does not switch the user's layout. Requested typing delays, drag durations and waits are not guarantees of renderer event intervals. Measured native/application timings remain separate.

During optional viewer navigation, a delivered zero-delay URL typing batch produced a malformed address. It was not blindly replayed: a fresh observation showed the wrong value, native set_value replaced it, another observation confirmed the exact value, then Enter opened the viewer. No cause was established. This is another reason to verify application state rather than treating delivery as success.

There is no public Windows raw hold, cross-call button/key state, hover, continuous curve, global release-all or immediate in-flight cancellation guarantee. These are outside the revised acceptance. Connected segments are separate complete strokes.

## Reproduce safely

```sh
npm test
npm run typecheck
npm run test:integration
node --experimental-transform-types scripts/verify-complete-input.mjs --native
```

The native verifier creates only its own local page and disposable Chrome profile. Its readonly HTTP event witness observes the application's handlers; it is not an input route. `scripts/complete-input-fixture.mjs --native` holds the same owned fixture for parent-tool verification; send `finish` to close it. `scripts/check-complete-input-cleanup.mjs` checks cleanup without killing processes or dispatching input. `scripts/export-complete-input-evidence.mjs` checks and exports only the redacted evidence fields.

See [usage](complete-input.md) and [the original native capability research](research/cua-input-capabilities.md).
