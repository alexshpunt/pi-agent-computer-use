# Visual predicate results

LPT-632 passed its approved standalone-tool scope in the main develop checkout. The production extension was reloaded before these checks. [The API](visual-classifier.md) accepts one image, one condition and the agent's threshold, with an optional uncertainty band. It does not need an opposite description or a state list.

## Production results

Actual Codemode calls used the pinned local TinyCLIP-39M model on saved, reviewed 86px crops. All 13 cases took their expected typed branch:

| Condition | Rule | Observed branches |
| --- | --- | --- |
| Cartoon mole in grass | threshold 0.309, band 0.005 | Four mole positives true; four grass crops, a stump and an orange ball false |
| Orange ball in grass | threshold 0.32, band 0.01 | Ball true; flower false |
| Wooden log in grass | threshold 0.269, band 0.015 | Score 0.269018 inside the band: null/unknown |

The program actually branched on `value === true`, `=== false` and `=== null`. An unchanged PNG image block matched the saved path's hash, score and true result. Missing pixels, text beyond the model token limit and an invalid band threw errors rather than returning false or null.

Cold full-tool wall time was **9512 ms**, including **8014 ms** of model load. The next 13 sequential calls took **31–69 ms**, median **49 ms**. A further repeat took **51 ms**, with `cache_hit:true` and zero model-load time. These are one local run's wall times, not a latency guarantee. The worker retains exact condition embeddings; new conditions do not reload the model.

The actual human viewport showed the 13/13 summary, cache/timing information and a direct “Visual condition: unknown” result with score and supplied rule. Text wrapped within the 161-column pane without broken escapes or clipped result lines. A verification-only read of the fixture's image-block JSON printed base64 in an earlier tool card; that was not classifier output. No private viewport PNG is published.

`computer_close` released the owned classifier worker. A read-only process check then found **zero** remaining classifier workers. No app was opened or closed, no screen was captured, no desktop input was sent and no paid call was made. Existing private model snapshots, environments and source screenshots remain in place.

## Verification and recovery

The isolated selected tree `e726469487de5ade416d351f2b0fccd587a16a31` passed **253 unit tests**, typecheck and **15 real-Pi integration tests**. Coverage includes numeric boundaries, image admission, worker reuse, error separation, abort, queue limits, queued-work shutdown and actual Codemode branching/close. The deterministic worker fixtures prove transport and branching, not model recognition; the production checks above used the real model.

The initial missing-module test was red before implementation. A test-only whitespace assumption and old registered-tool counts were corrected without weakening behavioral assertions. Concurrent selected-display work caused unrelated whole-workspace type errors, so qualification used only this task's selected files. Earlier resource-pressure runs are not claimed as passes; a fresh single-worker full run passed after memory recovered.

## Limits

The mole cutoff was chosen from the earlier synthetic score ranges before these evaluation calls. The four evaluation frames came from the existing reviewed experiment and include repeated grass/mole crops. The ball, flower and log controls are mirrored known synthetic fixtures, not independent held-out evidence. This small check does not establish reliability on arbitrary GUI states or questions.

Cosine is not calibrated probability. The unknown band does not catch every semantic error, and another wording, region or domain needs a separately chosen threshold. The earlier [negative experiments](research/larger-mole-negative-checks.md) found unreliable negation and overlapping scores for some questions.

No reactive click controller, alternate capture backend, CUA runtime change, Pi core change, OS setup or LPT-614 work is included. Redacted records are in [the evidence file](evidence/visual-classifier/run.json).
