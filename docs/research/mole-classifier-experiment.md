# Read-only mole classifier experiment

## Result

A text-prompted image encoder can distinguish cartoon moles from grass on the actual Level 10 board. This was a local research experiment, not a reactive tool implementation or a game-playing run. No game input was sent.

A later [TinyCLIP and SigLIP2 comparison](permissive-mole-classifiers.md) uses these same saved frames with checkpoints published under MIT or Apache-2.0. It does not adopt a production classifier.

We compared MobileCLIP2-S0 and S2 on the same 23 captured frames (14 distinct image hashes). Each frame provided 16 tiles: 24 visible-mole examples and 344 grass examples. Labels came from inspecting the actual pixels, including enlarged views of two tiny moles. The images contain repeated backgrounds and repeated states; these are not 368 independent examples or a general accuracy benchmark.

| Model / image precision | Moles found | False positives | Median GPU time, all 16 tiles | p95 |
| --- | --- | --- | --- | --- |
| S0 / FP32 | 22 / 24 | 0 / 344 | 52.7 ms | 52.9 ms |
| S0 / FP16 autocast | 22 / 24 | 0 / 344 | 42.8 ms | 43.2 ms |
| S2 / FP32 | 24 / 24 | 0 / 344 | 139.0 ms | 139.3 ms |
| S2 / FP16 autocast | 24 / 24 | 0 / 344 | 108.3 ms | 108.7 ms |

S0 missed two small moles during their appearance animation. Their tile crops still visibly contained a mole. S2 found both with the same prompts and decision rule. FP16 did not change the predicted classes in this sample. S2 is promising for this board, but this does not establish reliability on unseen screenshots.

## Method

The main Pi session captured the authorized game window through production `computer_observe`, invoked in Codemode. Hints and image guides were off. A fresh 500px overview preceded each native JPEG detail. The returned detail was 500x503; its board was split into sixteen approximately 86px square tiles using visually checked geometry. No DOM, game source, game network state, alternate capture backend or desktop input was used.

The fixed text prompts were:

- `a cartoon mole animal popping out of green grass`
- `a patch of green grass with no animal`

OpenCLIP loaded the `dfndr2b` checkpoints, set evaluation mode and reparameterized the image encoder with timm. Text embeddings were encoded and normalized once per process. Each image batch was encoded, normalized and compared with those cached text embeddings. A tile counted as a mole when its mole cosine similarity exceeded its grass similarity. There was no generated text, fine-tuning, prompt search or fitted threshold. Cosine scores are not calibrated probabilities.

The experiment kept the text tower loaded; it did not measure a minimal image-only runtime's memory use. Model initialization and the first text encoding are separate from the warm image timing. FP16 means CUDA autocast for the image encoder, with normalization and similarity comparisons in FP32. Twenty synchronized warm measurements were made per frame after three warm-up passes. GPU runs were serial, not concurrent. Python 3.14.4 ran in an isolated environment on the local NVIDIA GeForce RTX 3060 Laptop GPU, with four CPU threads.

The two FP32 reports predate the optional precision field in the probe script. Their commands used its FP32 default. The FP16 reports explicitly record precision.

## Capture is the larger delay

The measured overview-plus-detail pair took a median **884.5 ms**, p95 **1008 ms**, across 22 timed captures. Image preprocessing added about 18–21 ms per sixteen-tile batch; CPU-to-GPU transfer added about 3–6 ms. These stages were measured separately, not as a working capture-to-click loop. Saving files, Codemode scheduling and input delivery are not included in the GPU timing.

Apple's advertised mobile image-encoder latency is not a latency promise for this laptop, batch size or Python pipeline. The current tools do not provide a high-rate continuous frame stream. A fast classifier alone does not make the current overview/detail loop reactive.

Earlier captures were excluded because their chosen rectangle no longer covered the full board after the browser layout changed. One subsequent overview showed an article tab instead of the game; the user restored the game. We then grounded a new rectangle from a fresh overview. These observations are not evidence of a CUA geometry defect. A classifier must not interpret a misaligned or partly missing board as sixteen grass cells.

## Weights and license

The later [original MobileCLIP comparison and license-history check](legacy-mobileclip-experiment.md) tests pinned 2024 S0/S2 artifacts on these same frames. It documents an older license without the current research-only restriction; it does not approve production use.

The OpenCLIP weights resolved to these Hugging Face snapshots:

| Model | Repository / revision | Checkpoint SHA256 |
| --- | --- | --- |
| S0 | `timm/MobileCLIP2-S0-OpenCLIP` / `095906d28bf54d7584dc411e8ffe448f34289e05` | `ab91a1a0c4330d6b1913e24d5035dfdea15423316aaec649610c6b1c6ddd0e95` |
| S2 | `timm/MobileCLIP2-S2-OpenCLIP` / `ac6b37c8fc40b62b623d09ed228a6f0c9bc29fe6` | `92f6bdcf3665a31eb05b83e41e3de665055a9dfe2f8ed8274fcf7ee08c692d68` |

The [Apple model license](https://github.com/apple-aiml-research/ml-mobileclip/blob/main/LICENSE_MODELS) limits use to research purposes and explicitly excludes product development and commercial products/services. This experiment does not adopt MobileCLIP2 as a production dependency. Code licenses do not override the model license. No weights or screenshot pixels are committed.

Sources: [Apple MobileCLIP](https://github.com/apple-aiml-research/ml-mobileclip), [S0 model card](https://huggingface.co/apple/MobileCLIP2-S0), [OpenCLIP](https://github.com/mlfoundations/open_clip).

## Repeating the probe

The reusable [probe script](../../scripts/probe-mole-classifier.py) cannot capture a screen or send input. Its recorder accepts a JSON object on stdin whose `image` field is an image block (`data`, `mimeType`); capture remains with the computer-use tools. Keep captures, models, caches and environments in ignored `.tmp/` storage. Check the complete board and crop geometry before classification.

The environment used for this experiment was installed with:

```sh
uv venv --python 3.14.4 .tmp/mole-classifier/venv
uv pip install --python .tmp/mole-classifier/venv/bin/python \
  torch==2.11.0+cu128 torchvision==0.26.0+cu128 \
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .tmp/mole-classifier/venv/bin/python \
  open_clip_torch==3.3.0 timm==1.0.30 pillow==12.3.0
```

After collecting new private frames through the recorder:

```sh
HF_HOME="$PWD/.tmp/mole-classifier/hf" \
  .tmp/mole-classifier/venv/bin/python scripts/probe-mole-classifier.py \
  --model MobileCLIP2-S0 --precision fp16 \
  --frames .tmp/mole-classifier/valid --output .tmp/mole-classifier/s0-fp16 \
  --grid 72 73 89.5 86
```

Those grid numbers belong only to the captured detail layout in this experiment, not to a future window or overview. The current pretrained alias may resolve to newer weights; compare the downloaded revision and SHA256 with the table before treating a rerun as equivalent.

Inspect the generated contact sheet and prepare a labels JSON mapping each frame filename to its visible positive tile numbers (1–16, row-major). To assess already computed scores without loading a model:

```sh
python3 scripts/probe-mole-classifier.py \
  --assess .tmp/mole-classifier/s0-fp16/scores.json \
  --labels .tmp/mole-classifier/labels.json --frames .tmp/mole-classifier/valid \
  --output .tmp/mole-classifier/assessment
```

The experiment used private screenshots, which are not published; this note is an audit record, not a redistributable benchmark dataset.

## What this does not settle

This proves a two-class semantic comparison on known board tiles. It does not prove arbitrary visual reasoning, object localization, calibrated trigger thresholds, a durable classifier API, safe automatic clicking, or a low-latency feedback loop. Any integration needs its own scope decision, a compatible model license, capture measurements and validation on unseen states. Production tools and the installed CUA runtime were not changed.
