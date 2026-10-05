# Native Vision controls: remaining acceptance

LPT-374 overlaps with the shipped native controls in LPT-396/407. The CUA amendment supersedes the old 800px and selectable-kernel assumptions: current overview defaults to 500px, fixed Lanczos3 and scale 1. The panel does not change browser zoom. Provider/annotation controls remain future work; they were not silently added during the autonomous pass.

## Control-plane qualification

`test/cua-vision-settings.test.ts` now checks two real loopback servers with separate settings stores:

- Concurrent writes get distinct versions and replace the whole valid tuple. The other session stays at its defaults.
- One viewer's private route cannot address the other server.
- A frame recorded with its captured configuration retains that tuple and exact synthetic JPEG bytes after later changes. This is a trace/control-plane check, not a new Windows capture experiment.
- Missing/foreign Origin, wrong media type, invalid values, partial JSON, unsupported policy fields and oversized bodies leave the entire tuple unchanged. Non-settings routes cannot be written.
- Reset restores defaults. Existing checks reject the retired trial and unsupported MKS kernel.

The focused four tests and typecheck pass. New tests passed against the current implementation: they enforce an existing safety contract, not a reproduced missing feature. No production code, settings, window or driver pin changed, so no extension reload or new desktop reads were needed.

## What is still open

These checks do not complete LPT-374. The original acceptance also requests live structural/annotation toggles. The approved native migration explicitly did not adopt those extra controls. LPT-379 owns the model-facing annotation decision; human Qt window frames do not satisfy it. LPT-374 remains open rather than pretending native size controls cover every original requirement.

Existing live control evidence is in [the CUA browser report](cua-browser-results.md) and [native detail report](native-detail.md). The current tests add concurrent-session and rejected-write contracts; they do not claim provider delivery, atomic screenshot/tree readiness or untested platform parity.
