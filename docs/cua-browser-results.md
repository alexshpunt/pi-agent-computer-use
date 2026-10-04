# CUA owned-browser results

LPT-396 replaces the production Playwright browser with Cua Driver 0.33.1. The reloaded parent Pi and an isolated real-model Pi used only the new CUA tools on synthetic local pages. The human confirmed the independent native agent cursor was visible.

## Delivered

- One new driver-owned Windows Chrome browser with a fresh disposable profile. No personal browser attachment or IDE dependency.
- Six focused tools: open, focus, observe, act, tabs and close. Short hints belong to one native semantic snapshot; observations retire old hints. Existing Pi Codemode batches awaited inputs.
- Native whole-window PNG, including browser chrome, defaults to 500px long edge with Lanczos3. Exact scale and maximum-edge controls affect the next capture. No Sharp/image worker or duplicate resize engine remains.
- Fresh native padded JPEG zoom, up to 500px wide. Point clicks use the returned overview or zoom coordinates, mapped once by CUA. Saved-original and nested crops are retired.
- Before every overview/zoom, CUA raises only the exact owned browser. The user approved possible keyboard-focus switching. Results and debug metadata expose that effect. Capture-free input and tab listing do not raise it.
- Structured native refusals stop awaited Codemode even when MCP `isError` is false. Unknown input/launch is not replayed. Unknown cleanup blocks reopening.

## Observed proof

The [parent record](evidence/cua-browser/parent-foreground.json) contains actual returned bytes and metadata, with SHA-256 checks at export. Four capture-free hint clicks followed by one observation showed **Selections: 4**. Fill/submit showed **Pi CUA foreground parent396**. A grounded 500×257 JPEG showed **Native detail: cedar river 396**; one click at (58,56) in that JPEG produced **Selections: 5**. Hover, scroll and navigation used CUA; the next page matched both text and pixels. The scroll capture showed the expected page gap, not proof of reaching the bottom.

The exact debug controls were tested in another new owned browser. Scale 0.5 returned 249×178 pixels under a 250px cap; restoring scale 1 returned 500×357. All three exact images are saved as `parent-controls-*.png`. The viewer records native source, coordinate domain, foreground outcome, hashes and PNG/JPEG geometry. It polls the trace, not a continuous screen recording. Final provider/wire delivery remains unobserved.

Actual Herdr viewport checks used pane `w3E9:p6`, revisions 1005 and 1036. Input children, results, scale and foreground warnings were readable. Stock collapsed output did not show inline images; the agent inspected actual tool images and the human used the Windows browser/debug site. Cursor visibility comes from the actual human answer, not a cursor-excluded screenshot.

The [native adapter record](evidence/cua-browser/native-foreground.json) has 19 operations, six captures and six exact owned raises, retired-hint refusal and fresh-profile reopening. Final pictures show four selections, the submitted greeting and the next page. The [isolated production-model record](evidence/cua-browser/foreground-model.json) has 24 executions including Codemode child calls, using `openai-codex/gpt-6.1-sol`; these are not 24 independent model turns. Actual final pictures match four selections, submission and navigation. Its initial dark frames are preserved: bounded read-only observations recovered before input.

Final checks: **57 unit tests, typecheck and four real-Pi integration contracts passed**. Contracts cover ownership/handle lifetime, alias retirement, tab/page/geometry drift, zoom mapping, cancellation, partial/unknown input, foreground failures and cleanup. The clean staged snapshot passed the same 57 unit tests, typecheck and four real-Pi contracts. Its first run found a test-only missing temporary parent directory; the fixture now creates it itself and the clean rerun passed. Production code did not change after live verification.

Read-only cleanup confirmed both parent browser PIDs gone, Driver count 0 and profile entries 0. Only the owned fixture server was stopped. The separate official signed 0.33.1 runtime is pinned; desktop tools remain on 0.32.0. No global install, policy change or driver patch was used as the fix.

## Capability and feedback latency

Measured adapter durations from the single native foreground run above include WSL transport, identity/binding checks and output, not just Driver execution. They are not a timed benchmark or a general speed guarantee.

| Operation | Current support | Observed feedback |
|---|---|---|
| New owned browser / reopen | One isolated active tab | 5.11s / 4.66s |
| Four hint clicks without capture | Same snapshot, sequential Codemode | 0.85–0.90s each |
| Fill / submit | Text field replacement / semantic click | 0.92s / 0.95s |
| Full observation | Native foreground, semantics + PNG | 1.82–1.97s |
| Image-only observation | No semantic renewal, native foreground | 1.85s |
| Hover / bounded scroll | Semantic ref, native pointer API | 0.94s / 1.05s |
| Navigate without capture | Native browser route | 0.56s |
| Tabs / close | List only / whole owned-session cleanup | 0.55s / 0.36–0.43s |
| Fresh JPEG zoom + point click | Parent native proof above | No isolated latency estimate |
| Standalone tab create/activate/close | Not exposed; multiple/inactive tabs refuse image work | No hidden fallback |
| Arbitrary keys, coordinate movement, drag, dialogs, files | Not exposed by this slice | Explicit unsupported limit |
| Generic overlay boxes/text, desktop/display vision | Separate scope | No claim of implementation |

## Paint limitation and accepted compromise

A manually covered, non-minimized Chrome window reproduced a real mismatch: one click changed semantic state, but Windows captures stayed on the old paint through an extra 3000ms. Uncovering the same window without another click updated the image. The CUA foreground control also recovered current pixels in a separate human-controlled run. See [the research and unchanged failure evidence](research/cua-window-paint.md).

Automatic foreground is the accepted compromise, **not a paint-readiness guarantee**. A successful raise, semantic match or delay cannot prove current pixels. Inspect actual images and use bounded read-only observations when they disagree; never repeat input to force agreement. The underlying cause and a no-keyboard-focus solution remain open. Candidate Chromium flags were not proven, and the diagnostic library patch was not built or installed.

## Retired machinery and deferred work

Direct Playwright/Sharp dependencies and old browser/image workers, image kernels and retained-crop trials were removed. Playwright remains a **development-only transitive dependency** of `pi-coding-agent-test`, not a production browser backend. Old completed reports remain historical. The user-approved unfinished LPT-372 patch was archived and read back byte-for-byte before deletion; its game remains paused.

Approved amendments were applied and read back for LPT-372/376/374/378/379/382/383/384/385/386/387/388. They describe future CUA work, not completed features. IDE extraction, other apps/platforms, display vision, cache, context budgeting and Sandbox remain separate. A disposable browser profile is not an OS sandbox.
