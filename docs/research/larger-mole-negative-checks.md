# Larger classifiers on the same negative checks

Both TinyCLIP-39M and SigLIP2 Base fixed TinyCLIP-8M's stump and orange-ball errors with the original concrete descriptions. Neither became a reliable logical negation checker. Model size alone did not fix every phrase, and some results got worse.

## Same inputs and rule

We repeated the [TinyCLIP-8M negative experiment](mole-classifier-negatives.md) without changing its five text pairs, labels, crop grid or images. The saved game set has 23 frames, 14 distinct hashes, 24 mole tiles and 344 grass tiles. The synthetic board has twelve animal-free negatives and four unchanged mole controls, including two tiny moles.

We verified saved-frame hashes and the synthetic board hash before running. No new capture, game input, external image, prompt tuning, training or fitted threshold was used. This is still a small repeated-background experiment, not a general accuracy benchmark.

Each model encoded the two text descriptions once per run in FP32. Image encoding used FP16 autocast. Normalized FP32 cosine scores selected the first description only when its score exceeded the second. This forced choice has no rejection outcome. For SigLIP2, this tests two-description ordering, not calibrated sigmoid probabilities or multi-label thresholds.

## Original concrete descriptions

The descriptions stayed `a cartoon mole animal popping out of green grass` and `a patch of green grass with no animal`.

| Model | Saved moles found | Grass false positives | Synthetic controls found | Synthetic false positives |
| --- | --- | --- | --- | --- |
| TinyCLIP-8M, earlier run | 24 / 24 | 0 / 344 | 4 / 4 | 2 / 12 |
| TinyCLIP-39M | 24 / 24 | 0 / 344 | 4 / 4 | 0 / 12 |
| SigLIP2 Base | 24 / 24 | 0 / 344 | 4 / 4 | 0 / 12 |

Both larger models rejected the stump and orange ball that fooled TinyCLIP-8M. This supports testing them on unseen states. It does not establish a safe automatic action trigger.

## Other fixed description pairs

In each cell below, the first count is moles found and the second is false positives. Denominators are 24 moles and 344 grass tiles for the saved set, or four controls and twelve negative tiles for the synthetic board.

| Pair | TinyCLIP-39M saved: found / FP | TinyCLIP-39M synthetic: found / FP | SigLIP2 saved: found / FP | SigLIP2 synthetic: found / FP |
| --- | --- | --- | --- | --- |
| a mole is visible / no mole is visible | 23 / 0 | 3 / 4 | 0 / 0 | 0 / 0 |
| grass with a mole / grass without a mole | 24 / 0 | 4 / 7 | 23 / 0 | 3 / 0 |
| an image containing a mole / an image not containing a mole | 24 / 0 | 4 / 5 | 0 / 0 | 0 / 0 |
| this image shows a mole / this image does not show a mole | 18 / 0 | 2 / 0 | 23 / 0 | 3 / 0 |

SigLIP2 selected the absence description for every tile with both the visible and containing pairs. Zero false positives here comes with missing every mole. It is not a successful absence detector.

TinyCLIP-39M's with/without pair passed the saved grass set but produced seven synthetic false positives: soil patch, empty dark hole, log, stump, orange ball, stone and flower. The containing pair called the soil patch, hole, log, stump and ball moles. The visible pair called the soil patch, hole, stump and ball moles and missed tiny mole control 2. The shows pair missed both tiny controls.

SigLIP2's with/without and shows pairs each missed tiny mole control 1.

## Artifacts and verification

We reused the downloaded, pinned checkpoints and the same isolated Transformers environment on the local RTX 3060 Laptop GPU. Licensing and earlier timing are in the [comparison](permissive-mole-classifiers.md). No new dependency or production tool change was needed.

The twenty runs completed serially. Each frame used three warm-ups and one timed repetition. These timings are not a new latency comparison: machine load and power state were not controlled. All 7,680 cosine values were finite, and every prediction matched the fixed comparison rule. Both saved-frame baselines preserved their earlier perfect counts.

To repeat, follow the [negative experiment commands](mole-classifier-negatives.md#repeat), replace `TinyCLIP-8M` with `TinyCLIP-39M` or `SigLIP2-Base`, and use that model's exact snapshot path from the earlier comparison. Keep the same five pairs and separate output directories. Raw scores and private images remain in ignored `.tmp/mole-classifier`, retained at the user's request.

For the next unseen-state experiment, TinyCLIP-39M is worth testing with the original concrete descriptions. It matched SigLIP2 on this baseline test and had a lower warm batch time in the earlier comparison. Keep rejection/uncertainty and frame freshness as separate, unproven requirements. Do not compile arbitrary “not X” goals into trusted binary triggers based on these results.
