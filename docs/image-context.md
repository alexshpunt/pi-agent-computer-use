# Last three images in request context

LPT-380 limits each model request to the newest **three image payloads in total**. User attachments, tool results, Codemode output, overview and detail all share the limit. Repeating the same pixels still counts as another payload. Text-only turns do not evict an image by themselves.

The Pi `context` hook replaces older image blocks with short SHA-256/timestamp references. It also removes exact known encoded image data from ordinary text dumps. It does not rewrite stored messages, thinking signatures, tool calls/results or timestamps. This is not a general detector for obfuscated data in arbitrary text or tool arguments.

## Private resources and history

The latest 12 distinct supported images can be read again from private `.tmp/computer-vision/<session-id>/` files. The store is capped at 48MiB total and 16MiB per image. Unsupported or oversized resources are not archived. Storage failure does not disable the request limit; omitted pixels then have no promised resource.

An explicit image re-read joins the same three-payload budget. It does not authorize native input, desktop reading in Safe, or access to another session. Use the existing read tool and forward its image block, not an encoded-data text dump.

Shutdown/reload removes the session's temporary image store. The next request rebuilds bounded resources from the original current context. Compaction can remove older messages from that context, so not every historical image remains available as a temporary resource. Normal Pi session history and exports still contain their original images; this feature does not impose a disk quota on Pi's persistent history. Do not share private history or pixels.

Vision debug has separate bounded capture cards and action/request history. Its **Image context budget** section and Pi footer show active and omitted payload counts. Those counts describe the extension's request projection, not a continuous screen recording or remote-provider memory inspection.

## Transport checks

Qualified against Pi coding-agent 0.99.1 and the installed Pi AI 1.0.0 serializer:

- Real Pi with a loopback HTTP provider sends counts `0,2,3,3,3,3,3` for twelve PNG overviews/JPEG fixture crops in six Codemode batches. Old encoded pixels disappear; all twelve action labels remain.
- The native Codex cached-WebSocket serializer was exercised against a local protocol peer. Its first three image turns can chain. At eviction, the changed serialized prefix makes Pi reset `previous_response_id` and send reconstructed input. All 15 effective requests have at most three images. Explicit re-read, state reset and a compacted checkpoint pass.
- A separate real public-SDK run calls Pi's actual `reload()`, `compact()` with a loopback summarizer, and file reopen. It checks 17 request states, preserves 13 original user image entries, and verifies private-store removal/rebuild. This is not a hand-written compaction entry.
- Parent Pi after mandatory reload showed the footer `3/3 · 2 omitted` in the actual Herdr viewport and the private viewer reported matching bounded accounting. The stock collapsed tool renderer did not display inline PNGs.

Loopback usage is synthetic. No paid probe, remote billing measurement, cache-speed result or guarantee for other provider chaining protocols is claimed. Prefix reconstruction can lose cache reuse; LPT-381 owns cache strategy. Other extensions that later alter context/provider payloads are outside this extension's final-wire guarantee.

## Reproduce

```bash
npm test
npm run typecheck
npm run test:integration
node --experimental-transform-types scripts/verify-image-context-wire.mjs
node --experimental-transform-types scripts/verify-image-context-lifecycle.mjs
```

The two opt-in scripts use only synthetic images and local provider peers, not native screen capture or model credentials. [Redacted evidence](evidence/image-context/run.json) keeps counts, synthetic hashes and lifecycle results, not private parent pixels or viewer URLs.
