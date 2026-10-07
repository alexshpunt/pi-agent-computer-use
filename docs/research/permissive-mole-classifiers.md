# TinyCLIP and SigLIP2 on the saved mole frames

## Result

TinyCLIP-8M is the first candidate to test on unseen board states. It matched all manual labels and had the lowest warm batch time in this comparison. We have not adopted a production classifier or built a capture-to-click loop.

Follow-up [negative checks](mole-classifier-negatives.md) found failures on text negation and synthetic non-mole objects. The clean saved-grass result below does not establish safe yes/no triggers.

All three models found 24/24 visible moles with zero false positives among 344 grass tiles in both tested image precisions. The input was the exact 23 saved frames from the [first experiment](mole-classifier-experiment.md), with the same pixel-reviewed labels and fixed prompts. Only 14 image hashes are distinct. This is a small paired comparison with repeated backgrounds, not 368 independent examples or a general accuracy benchmark.

| Model / image precision | Moles found | False positives | Median GPU time, 16 tiles | p95 |
| --- | --- | --- | --- | --- |
| TinyCLIP-8M / FP32 | 24 / 24 | 0 / 344 | 21.7 ms | 24.0 ms |
| TinyCLIP-8M / FP16 autocast | 24 / 24 | 0 / 344 | 10.7 ms | 21.2 ms |
| TinyCLIP-39M / FP32 | 24 / 24 | 0 / 344 | 116.5 ms | 199.4 ms |
| TinyCLIP-39M / FP16 autocast | 24 / 24 | 0 / 344 | 38.5 ms | 47.0 ms |
| SigLIP2 Base/16-224 / FP32 | 24 / 24 | 0 / 344 | 507.9 ms | 514.9 ms |
| SigLIP2 Base/16-224 / FP16 autocast | 24 / 24 | 0 / 344 | 204.3 ms | 205.5 ms |

For context, [original MobileCLIP-S0](legacy-mobileclip-experiment.md) previously found all 24 moles at a median 44.4 ms in FP16. MobileCLIP2-S0 found 22/24 at 42.8 ms. Those are earlier runs, not a simultaneously controlled hardware benchmark. Machine load and power state were not fixed; the wide p95 values above are part of the observed result.

## Method and checks

The [probe](../../scripts/probe-mole-classifier.py) now supports these pinned Hugging Face checkpoints through Transformers 5.9.0. It uses local files only, checks the safetensors weight hash and refuses remote model code. No game source, DOM, network state, new screenshots or desktop input were used.

We created a separate ignored Python environment for Transformers. The existing MobileCLIP environment was not modified. Torch, torchvision and Pillow versions stayed the same as in the earlier experiment; complete selected versions are in [environment.txt](../evidence/mole-classifier/alternatives/environment.txt). All GPU runs were serial on the local RTX 3060 Laptop GPU, using four CPU threads and the SDPA attention backend.

The prompts remained:

- `a cartoon mole animal popping out of green grass`
- `a patch of green grass with no animal`

Each model used its own processor. SigLIP2 text used its required maximum-length padding: two sequences of 64 tokens. Text features were encoded once in FP32 and cached. Every image batch was encoded, normalized in FP32 and compared with the cached text features. The larger cosine score won. No prompt tuning, training or fitted threshold was used.

SigLIP's positive logit scale and common bias do not change this two-class ordering, so the probe compares cosine scores directly. This does not test calibrated sigmoid thresholds or multi-label events. Scores are not probabilities.

We checked the cached-feature route against each model's complete multimodal forward pass on the first 16-tile batch, including scale and SigLIP bias. The logits matched within 1e-4 tolerance and both routes selected tile 2. Every recorded cosine score across all six runs was finite. A deliberately wrong HF checkpoint was refused before model loading without producing scores. A one-repeat original MobileCLIP-S0 smoke check preserved all 23 frame predictions after the loader changes; its timing is not included in the comparison. See [checks.json](../evidence/mole-classifier/alternatives/checks.json).

Transformers emitted warnings about BOS/EOS identifiers in a default 32k SigLIP configuration. A separate read-only check confirmed that the pinned configuration actually has a 256k vocabulary, that the processor produced 64-token sequences and that every token was in range. We did not patch the model or library.

Image timing covers the encoder, normalization, two-column comparison and CUDA synchronization after three warm-up passes. There are twenty timed repetitions per frame. FP16 means CUDA image autocast, not a fully half-precision resident model or an optimized exported runtime. The text tower stayed loaded. Preprocessing, transfer, import/initialization and first text encoding have separate timings in the [six summaries](../evidence/mole-classifier/alternatives/).

The inherited 884.5 ms capture median in those summaries belongs to the earlier overview/detail capture pairs. It is not a new capture measurement. This comparison does not measure the newer temporal-capture tool, frame age, input latency or a live reaction loop.

## License and exact artifacts

The pinned publisher model cards declare **MIT** for both TinyCLIP checkpoints and **Apache-2.0** for the Google Hugging Face SigLIP2 checkpoint. These licenses permit product development and commercial use, subject to their notice and redistribution requirements. They do not contain MobileCLIP's current research-only exclusion.

| Model | Published snapshot | Weight file size |
| --- | --- | --- |
| TinyCLIP-8M | [`wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M`, `a2a8c6eaa2549ad66eb7c31b85022bf58273a26c`](https://huggingface.co/wkcn/TinyCLIP-ViT-8M-16-Text-3M-YFCC15M/tree/a2a8c6eaa2549ad66eb7c31b85022bf58273a26c) | 93,812,468 bytes |
| TinyCLIP-39M | [`wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M`, `07a4b0bc751cb64fecd2b661c048c1dd98d69444`](https://huggingface.co/wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M/tree/07a4b0bc751cb64fecd2b661c048c1dd98d69444) | 332,443,148 bytes |
| SigLIP2 Base | [`google/siglip2-base-patch16-224`, `75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2`](https://huggingface.co/google/siglip2-base-patch16-224/tree/75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2) | 1,500,800,904 bytes |

We downloaded those explicit revisions, including cards, configs and tokenizers, and verified the weights against the publisher's Git LFS hashes. [provenance.json](../evidence/mole-classifier/alternatives/provenance.json) records every downloaded file's size and SHA256. Model size names are not total memory estimates: the complete checkpoints contain about 23.45M, 83.10M and 375.19M tensor entries respectively, including text embeddings and stored buffers.

The HF snapshots have no standalone LICENSE file. TinyCLIP's cards link the [Microsoft MIT license](https://github.com/microsoft/Cream/blob/main/TinyCLIP/LICENSE). The [original Google repository](https://github.com/google-research/big_vision/blob/main/big_vision/configs/proj/image_text/README_siglip2.md) separately assigns CC-BY-4.0 to non-software materials; we used Google's Apache-2.0-labelled HF checkpoint, not an unidentified conversion. Do not treat every artifact called SigLIP2 as the same licensed distribution.

For redistribution, keep the applicable license and copyright notices; Apache distributions also need applicable NOTICE content and modification notices. Published permissions are not a warranty against patents, training-data claims or other third-party rights. This experiment checks the declared model licenses, not every possible legal issue.

## Repeat the comparison

Create the separate environment using the same Python interpreter:

```sh
uv venv --python .tmp/mole-classifier/venv/bin/python .tmp/mole-classifier/alternatives-venv
uv pip install --python .tmp/mole-classifier/alternatives-venv/bin/python \
  torch==2.11.0+cu128 torchvision==0.26.0+cu128 \
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .tmp/mole-classifier/alternatives-venv/bin/python \
  transformers==5.9.0 pillow==12.3.0
```

Download the exact model revision from the table into ignored `.tmp/mole-classifier/alternatives-hf/hub`. Keep its model card and processor/tokenizer files with the weights; compare all hashes with the provenance record. Use safetensors rather than the alternate pickle checkpoint.

For the downloaded TinyCLIP-8M snapshot:

```sh
HF_HUB_OFFLINE=1 .tmp/mole-classifier/alternatives-venv/bin/python \
  scripts/probe-mole-classifier.py --model TinyCLIP-8M --precision fp16 \
  --snapshot .tmp/mole-classifier/alternatives-hf/hub/models--wkcn--TinyCLIP-ViT-8M-16-Text-3M-YFCC15M/snapshots/a2a8c6eaa2549ad66eb7c31b85022bf58273a26c \
  --frames .tmp/mole-classifier/valid --output .tmp/mole-classifier/tinyclip-8m-fp16 \
  --grid 72 73 89.5 86
```

Use `TinyCLIP-39M` or `SigLIP2-Base` with their own snapshot paths for the other models. Run both precisions serially. Assessment uses the existing manual-label JSON, as described in the first experiment. The grid numbers apply only to these saved detail images.

Weights, environments, contact sheets and screenshots remain in ignored `.tmp/mole-classifier`, retained for further experiments at the user's request. Only the probe, redacted measurements, provenance and this report are committed. Production tools and the installed CUA runtime were not changed. A deployment decision still needs unseen-state validation and a separately measured, scoped reaction loop.
