# Images stay in normal Pi context

This extension never removes or replaces older image blocks, rewrites text dumps, or creates a separate image archive. User attachments, tool results, Codemode images, overview and detail follow the same Pi history lifecycle as other messages.

Pi's normal compaction may summarize older context and keep recent messages. It does not erase the original session entries. Reload alone does not remove images. This extension does not change compaction settings or provider cache controls. Other extensions and provider processing can still affect final delivery.

## Previews are separate

[Native previews](native-observability.md) show a bounded final operation image. Their lifetime does not limit model context, and they do not prove downstream provider delivery. Computer use keeps no debugger-only image mirrors or separate viewer archive. Private session history and operational captures must not be shared.

## Verification

Synthetic real-Pi, serializer and SDK checks confirm that tool, Codemode and user images stay in context across batches, reload and manual compaction, and that normal compaction reduces request context while the original image entries stay in session history. These checks use synthetic images and local provider peers. They prove retention/serialization, not remote billing, cache-hit rate, provider vision quality or universal provider compatibility. Keeping a stable prefix can help caching; it does not guarantee a cache hit.

## Reproduce

```sh
npm test
npm run typecheck
npm run test:integration
```
