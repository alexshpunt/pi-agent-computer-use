# Pi cache controls: transport boundary

LPT-381 is not complete. This bounded pass checks what the installed serializers send, not remote cache hits, cold/warm speed or billing. No account credentials, paid requests, second agent, prewarm or persistent settings were used.

## Actual local probe

Active Pi is 1.0.2; the TUI shows openai-codex / gpt-6.1-sol. The development dependency is pi-ai 1.0.0, while the active installation includes pi-ai 1.0.2. Their Codex serializer bytes match, but their public Responses files differ. The runner accepts a package root so the final [nine-request evidence](../evidence/cache-controls/run.json) uses the active installation, not an assumption about the dev dependency.

```sh
node scripts/probe-pi-cache-controls.mjs /usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai
```

Both real public SDK serializers call a loopback SSE peer. Each request contains the exact same synthetic JPEG. The peer emits marked synthetic usage to check parsing. No payload override is used. The first probe failed because the Codex request body was zstd-compressed, not plain JSON; the runner now decodes that real transport encoding. This failure was a probe defect, not a provider failure. The successful probe records source hashes and the actual cache fields.

| Serializer / controlled compatibility | `none` | `short` | `long` |
| --- | --- | --- | --- |
| Public Responses, older cache compatibility | No affinity key or retention field | Affinity key | Affinity key + retention `24h` |
| Public Responses, explicit-cache compatibility | `prompt_cache_options.mode=explicit`, no affinity key | Affinity key | Affinity key + `prompt_cache_options.ttl=30m` |
| Codex OAuth SSE | No affinity key | Affinity key | Same affinity key, no retention/options fields |

These are controlled fixture compatibility flags, not qualification of a remote model. `none` removing a key does not by itself prove server caching is disabled. The explicit public request has no breakpoints; its documented disable semantics do not transfer to the Codex row. All nine requests preserve the synthetic JPEG. Usage parsing correctly separates the supplied cached/write/uncached counts, but those counts are invented by the local peer, not billing evidence. No prewarm field is emitted.

The installed public Responses builder also deliberately omits retention/options for ChatGPT sign-in. Its comment says that route rejects those fields. An arbitrary application-boundary hook could forward extra JSON, but forwarding is not support. Do not add API cache options to the active Codex request just because the public API documents them.

## Current external documentation

[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and the [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create) document model-dependent explicit breakpoints and `prompt_cache_options.prewarm`. The Context7 `/websites/developers_openai_api` lookup confirms these public API fields. None of these sources qualifies the ChatGPT-authenticated Codex endpoint used here. Prewarm is cache preparation, not evidence of free work; its cost must be included in a later measured comparison.

[Claude prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) documents `cache_control`, prefix matching, model-specific minimum lengths and TTLs. This pass did not call Claude or qualify that serializer/account. Image/detail/tool changes can affect the reusable prefix; do not copy one provider's cache controls to another.

## Relationship to the three-image budget

LPT-380 already verifies the effective image budget on HTTP and native Codex cached-WebSocket serialization, including actual Pi reload/compaction/reopen. Its [report](../image-context.md) is the evidence for that contract. The WebSocket continuation ID is not a cache-hit counter: dropping an older image must reconstruct context when needed instead of silently retaining server-side images. Replacing an early image changes the prefix from that point onward; a cache may reuse the earlier unchanged prefix, not all the removed visual context.

Keep the shipped image budget and existing cache defaults unchanged. Do not reorder user/tool history for cache convenience, prewarm automatically or expose guessed provider controls. This is a safe unchanged baseline, not a measured optimal cache strategy.

## Remaining acceptance

LPT-381 still needs authorized remote cold/warm repetitions, actual usage and full cost/TTFT/cycle accounting for append, eviction, image/detail change, compaction and model change. A local peer cannot measure these. No paid matrix was started while the user was away. Provider prefill time remains unavailable unless the provider exposes it; TTFT is not prefill. The task remains open, with this runner supplying only the serializer/control boundary.
