# TinyCLIP negative checks

TinyCLIP-8M distinguishes moles from the saved grass background, but it is not a reliable logical yes/no checker. Several negation phrases failed badly. Even the original successful prompts called a synthetic stump and orange ball moles.

## How the classifier works

The text encoder turns two descriptions into vectors once. Each cropped image goes through the image encoder. We normalize both kinds of vector and compare their cosine similarity. The description with the larger score wins. There is no generated answer, logical negation operator or calibrated probability. This forced choice has no built-in “neither” or “uncertain” outcome.

The labels are text plus image, not a question-answer conversation. Changing “grass without a mole” to “no mole is visible” changes the text vector and can reverse the result. A successful phrase does not prove that the model understands negation in general.

## Text checks on the saved game frames

We used the same 23 frames, 14 distinct image hashes, 24 mole tiles and 344 grass tiles as the [comparison](permissive-mole-classifiers.md). The five pairs were fixed [before scoring](../evidence/mole-classifier/negatives/text-pairs.json). The first description always means mole present.

| Pair | Positive description / negative description | Moles found | False positives on grass |
| --- | --- | --- | --- |
| Baseline | cartoon mole popping out of grass / patch of grass with no animal | 24 / 24 | 0 / 344 |
| Visible | a mole is visible / no mole is visible | 2 / 24 | 344 / 344 |
| With/without | grass with a mole / grass without a mole | 24 / 24 | 0 / 344 |
| Containing | an image containing a mole / an image not containing a mole | 20 / 24 | 0 / 344 |
| Shows | this image shows a mole / this image does not show a mole | 20 / 24 | 344 / 344 |

These are paired tests on repeated backgrounds, not independent validation examples. The unchanged baseline preserved its earlier predictions. Complete confusion counts and failed frames are in [text summaries](../evidence/mole-classifier/negatives/text/).

## Controlled negative images

The user chose synthetic negatives rather than new captures or external photos. The [generator](../../scripts/build-mole-negatives.py) verifies every source frame against the saved dataset hashes, copies saved grass, and draws simple non-animal objects with Pillow. We reviewed the labelled contact sheet before scoring.

The twelve negatives are two plain grass tiles, a soil patch, an empty dark hole, a wooden log, a cut tree stump, a brown square, an orange ball, a grey stone, a red flower, a small tree and a purple check badge. Four unchanged crops of real game moles serve as controls, including two tiny moles. Only these four tiles are labelled positive.

| Pair | Moles found | False positives | Negative tiles called moles |
| --- | --- | --- | --- |
| Baseline | 4 / 4 | 2 / 12 | cut tree stump, orange ball |
| Visible | 2 / 4 | 5 / 12 | both plain grass tiles, soil patch, empty dark hole, cut tree stump |
| With/without | 4 / 4 | 2 / 12 | soil patch, orange ball |
| Containing | 2 / 4 | 2 / 12 | soil patch, empty dark hole |
| Shows | 3 / 4 | 10 / 12 | all except red flower and purple badge |

The visible pair missed both larger mole controls. The containing pair missed mole control 2 and tiny mole control 1. The shows pair missed mole control 2. Every failure remains in the [image summaries](../evidence/mole-classifier/negatives/images/); we did not tune prompts or thresholds after seeing it.

The [manifest](../evidence/mole-classifier/negatives/synthetic-manifest.json) records tile names, source crops and the board hash. A second generation produced identical PNG bytes. All four positive controls retained their source RGB pixels. This is one example of each drawn object, not a natural-image, other-animal or broad out-of-distribution benchmark.

## Runtime and checks

We used the same pinned TinyCLIP-8M checkpoint, processor, Transformers environment and RTX 3060 Laptop GPU as the earlier comparison. The exact revision is `a2a8c6eaa2549ad66eb7c31b85022bf58273a26c`; weight SHA256 is `9339ee3d736344d0ddcaa6c03edc9f89688f08caaea5401220885233da726fcc`. See the existing [provenance](../evidence/mole-classifier/alternatives/provenance.json) and [environment](../evidence/mole-classifier/alternatives/environment.txt).

All ten runs used local files only, FP32 cached text features, FP16 image autocast and normalized FP32 cosine comparisons. Each frame had three warm-ups and one timed repetition. Recorded timing is not a new latency benchmark. All 3,840 cosine values were finite, and every reported prediction matched the positive-greater-than-negative rule. Script syntax, CLI help and baseline regression passed. See [checks.json](../evidence/mole-classifier/negatives/checks.json).

No game source, DOM, new screenshots, external images, desktop input, model training or production integration was used. Private images, scores, environments and weights stay in ignored `.tmp/mole-classifier`, retained at the user's request. Only scripts, redacted measurements and this report are tracked.

## Repeat

Generate the private board:

```sh
.tmp/mole-classifier/alternatives-venv/bin/python scripts/build-mole-negatives.py \
  --frames .tmp/mole-classifier/valid \
  --output .tmp/mole-classifier/negatives/synthetic
```

Review its `contact.png` before scoring. Run the existing probe as in the [comparison](permissive-mole-classifiers.md#repeat-the-comparison), with `--repeats 1` and `--prompts` followed by the two exact strings from `text-pairs.json`. For each pair, use both the saved `valid` directory and the synthetic directory as `--frames`, with separate output directories. The grid stays `72 73 89.5 86`.

Assess each private score file using `--assess <output>/scores.json --labels <labels.json> --frames <frames> --output <summary-directory>`. Saved game labels are `.tmp/mole-classifier/labels.json`; synthetic labels are generated beside the board.

## What this means for a reactive layer

Prefer concrete descriptions of competing visible states over assuming that “not X” is X's logical complement. Even the best pair here needs broader negative validation. An eventual reactive layer needs a tested rejection or uncertainty rule and independently measured frame freshness; a larger cosine score alone is not enough to trigger a click safely. This experiment does not establish a threshold or approve a deployment.
