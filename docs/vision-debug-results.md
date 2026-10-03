# Vision debug viewer: results

[LPT-373](https://linear.app/alexshpunt/issue/LPT-373) was verified on 2026-10-03. The user chose the existing Pi API only. This result covers that narrowed scope, not a final transport inspector.

## What works

The extension starts a read-only loopback viewer for its Pi session. It shows three recent application-boundary image occurrences, bounded request text, adapter structures, nested computer-use calls, errors and available timings. `/computer-debug status`, `on` and `off` manage the viewer; no new model-facing tool was added.

The images come from decoded bytes in `before_provider_request`, not new human-only screenshots. SHA-256 links them to matching adapter captures. A capture not forwarded by Codemode remains separate. Identical captures have candidate source IDs, not a made-up unique source.

The page labels final delivery as **unconfirmed**, missing clean originals as **unavailable**, and unreported effective settings as unknown. Its three cards do not change model context. Existing browser screenshots already contain hints. Pi core, Pi Agent IDE and production provider configuration were not changed.

## Automated checks

The focused Git-index snapshot contains LPT-373 plus the committed browser baseline, without the unfinished LPT-372 changes. In that snapshot:

- 53 unit tests in nine files passed, including seven vision contracts.
- Typecheck passed.
- Four real-Pi integration tests passed.
- The staged diff check passed.

The new integration uses Pi's native OpenAI-compatible adapter against a loopback SSE fixture with a synthetic key. Received HTTP image bytes match the observed boundary hash. It checks nested call IDs, a deliberately unforwarded capture, a refusal, response metadata and server shutdown. [Native proof](evidence/vision-debug/native-provider.json) omits request bodies and base64.

A first scripted-provider test failed because that provider skipped the payload hook. It was replaced with the native-adapter fixture, not weakened. The fixture's transport equality does not prove equality for the parent Codex transport.

## Parent runtime and visible UI

The extension was reloaded twice in the actual parent Pi. The final reload includes a fix that keeps expanded action rows and their text scroll position across polling. Its regression test exercises the shipped frontend render function.

The owned browser opened only a synthetic local `/focus` page and this viewer. The parent sequence forwarded an image and text, clicked one known button compactly, captured an image without forwarding it, attempted an invalid hint, and forwarded the post-action observation. The fixture visibly changed from zero to one selection.

`node scripts/verify-vision-debug.mjs <viewer-url> <session-jsonl> <output>` fetched the retained assets and compared them with actual forwarded Pi tool-result bytes. All three retained images matched. [Parent summary](evidence/vision-debug/parent-run.json) and [frame metadata](evidence/vision-debug/parent-frames.json) preserve that checkpoint.

The actual browser showed:

- [Connected image cards](evidence/vision-debug/panel.png), the delivery warning and session identity.
- [An expanded refusal](evidence/vision-debug/error.png) with its input, nested parent ID, error text and duration. It stayed expanded across subsequent requests/polls.
- [Adapter structure](evidence/vision-debug/structure.png), separately labelled from request text.
- [Reconnection](evidence/vision-debug/reconnected.png) through navigation to the same URL, retaining the current trace.

`inspect_tui` captured the real Herdr viewport, pane `w3E9:p6`, revision 1553: [parent TUI](evidence/vision-debug/parent-tui.png). The vision status and normal tool rows were readable. Codemode images were collapsed there; this capture is not a claim that the browser panel rendered inline in the terminal. It also shows errors from the separate `<boundary>` extension resolving persisted assistant IDs after session surgery. Those are not vision-server errors and were not changed in this task.

The previous viewer URL refused connections after reload. The fresh viewer had a new nonce route and fresh action state. Earlier images still present in Pi's conversation can reappear at the next observed request; they are honestly unmatched, not inherited adapter provenance. Unit checks cover a different-session reset; the isolated real-Pi integration checks process shutdown.

The owned browser/profile and synthetic fixture server were closed after verification. The current session's viewer remains available until `/computer-debug off`, reload or shutdown.

## Timing and limits

At the final parent hash checkpoint, the compact button action took about 42 ms; its adapter input stage was about 35 ms. Captured-only and full observations each took about 114 ms. The invalid-hint refusal took about 3.4 ms. These are individual local measurements, not a general performance guarantee.

Twenty local `/state` reads measured p50 7.67 ms and p95 9.71 ms. This excludes capture, frontend rendering, model reasoning and provider latency. The one-second polling interval is separate.

Production boundary delivery, provider resize/embeddings, clean originals and effective configuration remain unobserved. JPEG/WebP/GIF bytes are retained when supported, but only PNG dimensions are currently decoded. Old provenance/assets can leave the bounded trace. The viewer shows boundary occurrence order, not a deduplicated capture history.

## Scope left unchanged

LPT-372 remains paused and its uncommitted browser work was preserved, not included in this delivery. The 1086/1085 region regression remains unresolved in LPT-377. The Neal game was not resumed. Vision controls belong to LPT-374; the effective image-context budget belongs to LPT-380. No package publication or persistent installation was performed.
