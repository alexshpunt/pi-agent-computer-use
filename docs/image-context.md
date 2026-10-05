# Images stay in normal Pi context

The user superseded LPT-380's last-three request limit. This extension no longer removes or replaces older image blocks, rewrites text dumps, or creates a separate image archive. User attachments, tool results, Codemode images, overview and detail follow the same Pi history lifecycle as other messages.

Pi's normal compaction may summarize older context and keep recent messages. It does not erase the original session entries. Reload alone does not remove images. This extension does not change compaction settings or provider cache controls. Other extensions and provider processing can still affect final delivery.

## Debug cards are separate

Vision debug keeps three recent application-boundary cards and bounded action/request metadata. That is a viewer memory limit, not a model-context limit. Its request summary counts all observed image blocks. There is no image-budget footer or active/omitted projection. Private session history and debug pixels must not be shared.

## Verification

- The real-Pi HTTP regression first reproduced the retired behavior: `0,2,3,3,3,3,3`. With the context hook removed, twelve distinct PNG/JPEG images in six Codemode batches arrive as `0,2,4,6,8,10,12`. The oldest bytes and all action labels remain; only three debug cards are retained.
- The native Codex cached-WebSocket serializer and local peer retain all twelve exact image hashes in effective context. Requests after the first keep the unchanged continuation prefix. A manual serializer checkpoint reconstructs context; it is not a Pi compaction test.
- The public Pi SDK run verifies twelve user images, actual reload, actual manual compaction with a loopback summarizer, another reload and saved-file reopen. Reload preserves all twelve images. Normal Pi compaction reduces request context while the twelve original image entries stay in session history. No separate archive is created.

After mandatory parent reload, the real private viewer showed the new retention caption and no budget section. Its application-boundary request counted five images while displaying three cards. The actual Herdr viewport (`w3E9:p6`, revision 500, 182×57 cells) showed the normal vision-debug status without the removed image-budget footer. Tool images were collapsed; this is not an inline-PNG claim. The owned viewer closed, and read-only checks found no owned window/browser, Driver or profile.
These checks use synthetic images and local provider peers. They prove retention/serialization, not remote billing, cache-hit rate, provider vision quality or universal provider compatibility. Keeping a stable prefix can help caching; it does not guarantee a cache hit. See [the cache boundary](research/pi-cache-controls.md).

## Reproduce

```sh
npm test
npm run typecheck
npm run test:integration
node --experimental-transform-types scripts/verify-image-context-wire.mjs
node --experimental-transform-types scripts/verify-image-context-lifecycle.mjs
```

[Current synthetic evidence](evidence/image-context/retention.json) records counts, hashes and lifecycle checks. The earlier [last-three evidence](evidence/image-context/run.json) remains historical. That policy was delivered at `6dca15129f68a2e872baa3e76b9b43d553f29a0b` and explicitly reversed by the user; it is not the current contract.
