# Images stay in normal Pi context

The user superseded LPT-380's last-three request limit. This extension no longer removes or replaces older image blocks, rewrites text dumps, or creates a separate image archive. User attachments, tool results, Codemode images, overview and detail follow the same Pi history lifecycle as other messages.

Pi's normal compaction may summarize older context and keep recent messages. It does not erase the original session entries. Reload alone does not remove images. This extension does not change compaction settings or provider cache controls. Other extensions and provider processing can still affect final delivery.

## Debug cards are separate

Vision debug keeps three recent application-boundary cards and bounded action/request metadata. That is a viewer memory limit, not a model-context limit. Its request summary counts all observed image blocks. There is no image-budget footer or active/omitted projection. Private session history and debug pixels must not be shared.

## Verification

Synthetic real-Pi, serializer and SDK checks confirm that tool, Codemode and user images stay in context across batches, reload and manual compaction, and that normal compaction reduces request context while the original image entries stay in session history. These checks use synthetic images and local provider peers. They prove retention/serialization, not remote billing, cache-hit rate, provider vision quality or universal provider compatibility. Keeping a stable prefix can help caching; it does not guarantee a cache hit.

## Reproduce

```sh
npm test
npm run typecheck
npm run test:integration
```
