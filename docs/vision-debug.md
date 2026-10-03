# Vision debug viewer

[LPT-373](https://linear.app/alexshpunt/issue/LPT-373) added the local observation viewer for the current Pi session. [Agent image size](vision-scale.md) now adds a narrowly scoped resizing control form. It uses existing extension hooks, not a provider override, a second JavaScript executor or a new model-facing tool.

## Open and stop

The extension starts the viewer on `session_start` and prints its URL. `/computer-debug status` shows it again. `/computer-debug off` closes the server and clears retained pixels; `/computer-debug on` starts a fresh viewer.

The URL has a random per-server path. The server listens on `127.0.0.1` only, rejects foreign Host/Origin headers. Reads expose the trace and random reading samples. Same-origin, bounded JSON writes apply an image-settings tuple or grade one reading trial and start the next. Expected text stays out of the HTML/JSON. Do not publish or forward it. A process with access to this session's URL can read its retained UI data and change image resizing settings; this is not an OS sandbox. There is no persistent service or machine configuration.

Closing/reloading the Pi session closes the server. A new session has a new viewer URL and no previous-session frames. Reopening the same URL while its server is running reconnects to current state. After shutdown, the old URL is unavailable.

## What the panel proves

The user chose to use only Pi's existing API. `before_provider_request` provides a mutable application-boundary payload. The viewer copies image bytes from that event and hashes the decoded bytes with SHA-256. It also keeps bounded text excerpts and the payload paths where they appeared. It never mutates the payload, filters model history or fetches remote images.

**Final delivery is unconfirmed.** Later extension handlers can replace the payload. Codex WebSocket can derive a delta request and use server-side context. Provider-internal resize and embeddings are not available. A provider response is recorded, but does not prove the original hook payload was sent unchanged. Frames remain `prepared`, not `sent`.

The three displayed images are a viewer limit, not the effective image budget tracked in LPT-380. Existing context can contain more images.

## Images, structure and actions

- The boundary-image cards show time, decoded byte count, PNG dimensions when known, hash, detail when provided, request ID and payload path.
- Browser/Windows tool hooks record adapter images and metadata separately. A capture not forwarded by Codemode stays in the adapter trace and does not become a new boundary-image card.
- Image hashes link pixels to matching computer-use actions. Identical captures are ambiguous: the panel lists candidate calls rather than assigning a unique source.
- Adapter structure is labelled separately from observed provider text. Metadata in tool `details` is not automatically model input. Text excerpts are labelled when truncated.
- The browser capture can already include DOM hints. The resizing path retains the exact pre-resize PNG separately, not a clean pre-overlay capture. Other adapters can still report originals as unavailable. It does not substitute a second screenshot.
- Requested settings and known adapter timings are recorded. Effective settings not reported by the adapter remain unknown. The viewer cannot change Safe/YOLO. LPT-375 adds only resizing controls; the broader options in LPT-374 remain separate.

## Bounds and cleanup

The in-memory trace retains 100 computer-use action records, 20 request summaries, three boundary frames and three recent adapter captures. Each retained image is limited to 12 MiB; the total asset budget is 48 MiB. Over-budget assets are evicted explicitly. Text and metadata are bounded, and the JSON state endpoint contains no image base64. Old source bytes are not promised after eviction.

The panel polls current state once per second. That refresh interval is not an input or provider-latency measurement. Action durations come from the hook timestamps, while capture/input stage timings come from the existing adapter when available. Concurrent nested calls remain distinct by their call IDs and parent IDs.

## Verification

`npm test -- --run test/vision-debug.test.ts` checks byte identity, captured/prepared separation, ambiguous provenance, bounded viewer history, session reset, host/origin rejection, reconnect and cleanup.

`npm run test:integration -- --run test/vision-extension.integration.test.ts` runs real Pi with its native OpenAI-compatible provider adapter against a loopback SSE fixture. It compares a boundary image hash with the bytes actually received by that fixture, exercises nested Codemode calls, deliberately does not forward one capture, records an input refusal and verifies server shutdown. It does not use real credentials or an external API.

The integration writes `vision-trace.json` and `provider-bodies.json` beside its normal run artifacts. A scripted test provider that skips `onPayload` cannot qualify this boundary; use the native-adapter fixture instead.

For a parent session, `node scripts/verify-vision-debug.mjs <viewer-url> <session-jsonl> [output-directory]` compares retained assets with forwarded Pi tool-result bytes and saves proof. Run it after synthetic observations, a captured-only frame and an input refusal. Its timing measures local state reads only.

[Verified results and visible evidence](vision-debug-results.md) include parent reload, browser reconnect and the real TUI capture. Action rows keep their expanded state during polling.
