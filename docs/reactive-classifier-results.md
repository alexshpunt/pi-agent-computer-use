# In-memory crops and a bounded reaction loop

## What changed

`computer_classify` accepts either one integer `region` or an ordered `regions` array of 1..16 crops from the supplied image. The warm Python worker decodes once, crops in memory and encodes all requested crops in one GPU batch. There is no extra capture, crop process or temporary image in classification.

Each result keeps the source frame's hash and dimensions. A batch returns independent ordered decisions, not an aggregate boolean. Invalid rectangles, conflicting options, EXIF rotation and excessive total crop area reject the request. Whole-image classification stays unchanged. Classification neither consumes nor renews native input authority.

The [reactive classifier skill](../.pi/skills/reactive-visual-classifier/SKILL.md) covers finite budgets, cancellation, frame-age checks, completed and pending targets, and bounded output. It is guidance, not an enforced runtime sandbox. Concurrent single-crop requests are serialized; they are not a model batch.

## Verification

Region and batch regression tests first failed, then passed after implementation. The final focused check passed 11 classifier unit tests, typecheck, one real-Pi integration test and Git whitespace checks. Python worker syntax also passed. Tests cover crop-dependent branching, ordered true/false/unknown results, malformed receipts, whole-request rejection and worker lifecycle. They do not assert skill wording.

After mandatory reload, production metadata exposed `regions` and its structured batch result. Real TinyCLIP scores for a known positive crop and a white crop matched their individual calls within 1e-4, in input order. They returned true and false. An invalid last crop threw without a partial result. A warm batch of 16 repeated positive regions took 66ms wall time, including 55.8ms worker inference/preprocessing. Cold model loading took 10.14 seconds and was kept outside game actions.

This small saved-image check proves transport and real-model batch consistency, not general semantic accuracy. The exact model assets and local Python environment were reused without installation or downloads.

## Earlier latency measurements

Two warm read-only samples before in-memory cropping used this path:

| Stage | Sample 1 | Sample 2 |
| --- | ---: | ---: |
| Overview | 237ms | 254ms |
| Native detail capture | 341ms | 340ms |
| Crop helper process | 183ms | 166ms |
| Classifier | 46ms | 24ms |
| New overview before input | 306ms | 239ms |
| Total before input | 1113ms | 1023ms |

Removing native detail and shell cropping let three single-region chunks confirm seven selections. Overview medians were 215–244ms, classifier medians 55–66ms, and capture-completion-to-action-call medians 152–278ms. Action call medians ranged from 129 to 463ms. The total 300-second budget later expired with no further input. The level was not passed.

A later read-only field snapshot took 100–114ms. Fourteen separate classifier calls still took 583–837ms despite concurrent submission. This motivated true batching. Requested 1Hz pacing was then explicitly revoked by the user; the final runs had no sleep calls.

## Final live batch run

Only the authorized existing Chrome game window was used. The initial whole-window overview established a 4×4 board and its current state. Sequential one-frame native captures covered only the 246×246 playing field. Each batch excluded selected and pending cells before classification. The English condition was `a cartoon mole animal popping out of green grass`, with threshold 0.29 and uncertainty 0.01. This is a narrow task cutoff, not a calibrated probability.

Temporal frames grant no input authority. A positive detection therefore triggered a fresh window overview and a single-crop recheck before a hinted native click. That recheck had a 300ms limit measured from overview return, not the compositor's pixel timestamp. Each delivered click was verified with at most three fresh reads. Unknown input was never replayed.

Attempt 4 stopped after one click because the program incorrectly searched the entire receipt for the word `unknown`. A read-only follow-up visibly confirmed cell 14 was selected. The next program parsed the exact top-level action status instead and did not repeat that cell.

The final allowed attempt reached its 60-frame budget after 34.95 seconds:

- 60 field snapshots and 60 batches; 463 eligible crops evaluated.
- Nine delivered clicks, all nine application-confirmed; no pending actions or numerical unknowns.
- Ten cells selected in total, including the prior confirmed cell.
- No clicks on confirmed cells, no artificial sleeps, no Verify click.
- The final whole-window image still showed Level 10. **The level was not passed.** The five-attempt limit ended further play.

| Stage | Median | Maximum |
| --- | ---: | ---: |
| Field capture call | 146ms | 283ms |
| Batch classification call | 115ms | 318ms |
| Fresh authority overview | 302ms | 375ms |
| Candidate recheck | 62ms | 69ms |
| Action call | 503ms | 569ms |

Frame selection and verification also cost time. These are separate call measurements, not an additive end-to-end percentile. The action call includes admission and receipt processing; no reliable physical-input breakdown was retained. The remaining measured cost is mainly fresh observation and action handling, not model encoding alone.

## Output and safety observations

Hot-loop frames, scores and receipts stayed inside Codemode. Only small final counter/timing summaries were emitted. The actual human TUI viewport was inspected: the summaries and explanation were readable, with bounded collapsed call previews. Images appeared as attachment placeholders in that viewport; inline image rendering was not established.

Earlier text-editor image persistence leaked base64 through an automatic edit receipt. That private file and the obsolete helper were removed. The skill warns against this path; this experiment does not claim that every earlier operation was leak-free. Codemode can still show bounded call previews or calls completed before cancellation.

Immediate verification initially missed selection animation. Selected cells also have slightly shifted centers, so exact vertical sorting misnumbered them. The live program instead used rounded grid positions, checked all 16 unique cells and rejected layout changes. Application-confirmed selection was kept separate from animal detection.

This is evidence for one bounded game run, not universal accuracy or guaranteed reaction latency. The game and other application windows remain open. This work did not change native setup, permissions, driver code or OS settings, and preserved the reviewed model assets.

See [the compact measured evidence](evidence/reactive-classifier/run.json).
