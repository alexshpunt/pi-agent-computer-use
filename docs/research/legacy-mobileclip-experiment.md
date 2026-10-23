# Original MobileCLIP weights: license history and mole comparison

## Result

The original MobileCLIP-S0 and S2 found all 24 visible moles, with no false positives among 344 grass tiles, in both tested image precisions. The faster S0 is worth testing on unseen frames next. This is not production adoption or proof of a reliable reactive loop.

We reused the exact 23 frames and manual labels from the [MobileCLIP2 experiment](mole-classifier-experiment.md), checked against its recorded hashes. Only 14 image hashes are distinct. Repeated backgrounds and states mean this is a small paired comparison, not 368 independent examples.

| Model / image precision | Moles found | False positives | Median GPU time, all 16 tiles | p95 |
| --- | --- | --- | --- | --- |
| Original S0 / FP32 | 24 / 24 | 0 / 344 | 54.9 ms | 56.5 ms |
| Original S0 / FP16 autocast | 24 / 24 | 0 / 344 | 44.4 ms | 61.2 ms |
| Original S2 / FP32 | 24 / 24 | 0 / 344 | 144.4 ms | 145.6 ms |
| Original S2 / FP16 autocast | 24 / 24 | 0 / 344 | 74.9 ms | 105.7 ms |
| MobileCLIP2-S0 / FP16, earlier run | 22 / 24 | 0 / 344 | 42.8 ms | 43.2 ms |
| MobileCLIP2-S2 / FP16, earlier run | 24 / 24 | 0 / 344 | 108.3 ms | 108.7 ms |

Original S0 found the two tiny animated moles missed by MobileCLIP2-S0. All prompts, labels and the decision rule stayed unchanged. This does not establish that original S0 is generally more accurate than its successor.

Runs were serial on the same RTX 3060 Laptop GPU, but machine load was not controlled. One stalled run left the final S2/FP16 case incomplete. After confirming no probe process remained, we ran only that missing case. Do not interpret small timing differences as a controlled hardware benchmark.

## How we ran it

We used Apple's unmodified original implementation at commit [`341ef058802f0e4e5ab13c02f0cb32a3a94e367b`](https://github.com/apple-aiml-research/ml-mobileclip/tree/341ef058802f0e4e5ab13c02f0cb32a3a94e367b), with its evaluation and reparameterization enabled. The existing isolated Python environment worked without installing more dependencies. Original S0 and S2 have different text towers; the script used each model's own tokenizer and preprocessing.

The [probe script](../../scripts/probe-mole-classifier.py) now accepts explicit legacy source and checkpoint paths. It verifies the checkpoint SHA256 before loading it. A deliberately wrong checkpoint was rejected without producing a score report. That byte check does not verify licensing or source provenance; those need the separate snapshot record below.

The fixed prompts were `a cartoon mole animal popping out of green grass` and `a patch of green grass with no animal`. Text embeddings were computed once. A mole prediction means its cosine score exceeded the grass score, not that a calibrated probability passed a threshold. Image timing used three warm-ups and twenty synchronized measurements per frame. FP16 means image CUDA autocast, followed by FP32 normalization and comparison.

No new screenshots or game input were used. The capture median of 884.5 ms in the summaries comes from the earlier overview/detail captures, not this model run. It remains larger than the encoder time. Preprocessing, transfer and startup were timed separately. No capture-to-click loop was measured.

## What the license history actually shows

The official July 22, 2024 Hugging Face snapshots contain both the weights and an actual Apple license file, not merely a README link. We downloaded those pinned snapshots, including their license, README and config, and checked weight hashes against their Git LFS metadata.

| Model | Official 2024 snapshot | Checkpoint SHA256 |
| --- | --- | --- |
| S0 | [`5e1c3d84ff3c309b922efa9664423354cbc645a7`](https://huggingface.co/apple/MobileCLIP-S0/tree/5e1c3d84ff3c309b922efa9664423354cbc645a7) | `809b408eff74f8058843e86a1f92967097d42ba782450e85b8f4867b7f0ca0b7` |
| S2 | [`22fec9d0b9b614cb270f3322bbb80bf98a3f9c2f`](https://huggingface.co/apple/MobileCLIP-S2/tree/22fec9d0b9b614cb270f3322bbb80bf98a3f9c2f) | `063a87b2a846791bcffafa9f7670ec3968d572a3e7f99e5e4b14348006631d6f` |

The 2024 license grants a personal, non-exclusive copyright license to use, reproduce, modify and redistribute the Apple software in source or binary form. It contains **no research-only, non-commercial or product-development exclusion**. It requires keeping the notice and disclaimers when redistributing the software in its entirety without changes, prohibits Apple endorsement without permission, grants no patent rights and provides the software as-is. Both snapshots contain identical license bytes, SHA256 `18e4e6b95d7272051fabdad125ba0467549c181ef20b7fa0eafbac3825471483`.

There is an important correction to the idea that only MobileCLIP2 has the restricted license: **Apple changed the first-generation S0/S2 license too, on February 24, 2025**. The current snapshots contain the same checkpoint hashes as in 2024, but a research-only license. See the official [S0 history](https://huggingface.co/api/models/apple/MobileCLIP-S0/commits/main) and [S2 history](https://huggingface.co/api/models/apple/MobileCLIP-S2/commits/main).

Therefore neither “first generation” nor the weight hash alone identifies the applicable license. A current alias is not a substitute for the full historical snapshot.

### Can we put these weights in the extension?

The 2024 publication gives a documented basis for considering these particular historical artifacts, unlike the explicit product-development restriction in the current license. It is not an Apple confirmation or a legal opinion that acquiring a historical snapshot today settles every issue for new production use after the license change. This experiment does not resolve that question through a court decision, legal review or permission from Apple.

For production, retain the complete historical provenance and notices, and obtain qualified legal review or written permission before relying on that interpretation. Do not describe the current MobileCLIP weights as unrestricted or distribute them under this repository's code license. Open-source distribution alone does not remove model-license restrictions.

## Repeat only with pinned artifacts

Use the existing environment described in the earlier experiment. Clone the Apple source into ignored `.tmp/` storage and select the source commit above. Download each Hugging Face snapshot with its explicit revision, including `LICENSE`, `README.md`, `config.json` and the named checkpoint. Keep those files together; do not download `main` and attach an older license afterward.

For example, once the exact S0 snapshot has been downloaded to the local cache:

```sh
.tmp/mole-classifier/venv/bin/python scripts/probe-mole-classifier.py \
  --model MobileCLIP-S0 --precision fp16 \
  --legacy-source .tmp/mole-classifier/legacy-source \
  --checkpoint .tmp/mole-classifier/legacy-hf/hub/models--apple--MobileCLIP-S0/snapshots/5e1c3d84ff3c309b922efa9664423354cbc645a7/mobileclip_s0.pt \
  --frames .tmp/mole-classifier/valid --output .tmp/mole-classifier/legacy-s0-fp16 \
  --grid 72 73 89.5 86
```

Those grid numbers apply only to these saved frames. The script cannot capture or click. Assessment uses the same pixel-reviewed labels as the earlier experiment.

Weights, screenshots and environments remain private in ignored `.tmp/mole-classifier`, retained at the user's request. Only license text, provenance and redacted measurements are committed. Production tools, runtime and permissions were not changed by this experiment.
