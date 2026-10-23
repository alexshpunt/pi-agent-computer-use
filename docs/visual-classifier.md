# One visual condition

`computer_classify` evaluates supplied pixels against **one** text condition with local TinyCLIP-39M. It does not capture a screen, click, call another reasoning model, or ask for competing states.

The agent chooses the threshold for the wording and image domain. A raw cosine score is **not a probability**. This is a fast thresholded similarity check, not a general visual question-answering model.

## API

```js
// An image Read in Codemode returns an image block; without IDE use tools.computer_read.
const view = await tools.read({path: load("window"), views: ["image"]});
const result = await tools.computer_classify({
  image: view,
  condition: "a cartoon mole animal popping out of green grass",
  threshold: 0.309,
  uncertainty: 0.005
});
if (result.value === true) {
  text("Condition met");
} else if (result.value === false) {
  text("Condition not met");
} else {
  text("Unknown: inspect or wait");
}
```

That threshold was checked on 86px saved mole tiles, **not on the whole window in the example and not on other wording or apps**. Choose and verify a cutoff for the actual input region; the example only shows image-block transfer and branching. Classification gives no input authority: a supplied image may be old, cropped or annotated. Follow the normal observation/action contract before acting. If precise classification matters, use suitable crops without distracting annotation.

- `image`: a saved local path (relative to the call's workspace) or an unchanged `{type:"image", data, mimeType}` block. PNG, JPEG or WebP; one frame, at most 10 MiB and 16 million pixels. No URL download or implicit capture. Selected sequence frame images also work.
- `region`: optional `{x,y,width,height}` rectangle in the supplied image’s encoded pixels. All four values are integers; x/y are nonnegative and width/height positive. It must lie fully inside the frame; there is no clipping, padding, resize or implicit capture. EXIF-rotated region input is refused. The warm worker crops in memory before encoding. The returned `image` hash/dimensions still identify the whole supplied frame; returned `region` identifies the evaluated part. Classification does not consume or renew an observation’s input authority.
- `regions`: alternative to `region`, an ordered array of 1..16 rectangles. One supplied image is decoded once and all crops share one image-encoder batch, one condition and one cutoff. Total crop area must not exceed 16 million pixels. Any invalid region rejects the entire request. Choose `region` or `regions`, never both.
- `condition`: one nonempty text description or question, up to 2048 characters and the model's token limit. Long text is rejected, never silently truncated. There is no opposite prompt.
- `threshold`: required finite number in [-1,1], chosen by the agent.
- `uncertainty`: optional nonnegative band half-width; defaults to 0. Both band edges must lie within [-1,1].

The rule is inspectable:

```text
score > threshold + uncertainty  -> true
score < threshold - uncertainty  -> false
inside the closed band          -> null (unknown)
```

Boundary comparisons allow 1e-12 for floating-point rounding. Even with a zero-width band, an exact tie is unknown. Use `=== true`, `=== false` and `=== null`: do not collapse unknown into false.

The structured result contains `status:"classified"`, `value`, raw `score`, the supplied rule and condition, `model`, `cache_hit`, image SHA256/dimensions and `timing_ms` (full call, inference/preprocessing, model load). Errors throw and do not return false/null. Nothing in this result grants calibrated confidence.

With `regions`, the structured result has `results:[{region,value,score}, ...]` in input order, plus the common source image, rule, cache and timing metadata. It has no aggregate `value` or `score`. Each crop can independently be true, false or unknown. An empty batch is an error; skip the call when no eligible targets remain.

Use one batch request, not concurrent single-crop calls. The worker serializes requests; concurrency does not combine separate requests into a model batch. Exclude selected and pending targets before building the regions, and keep all intermediate results inside the reaction program.

## Local setup

The extension starts no model process until its first classification. Configure these trusted local paths in ignored `.pi/visual-classifier.json`:

```json
{
  "python": "/path/to/your/qualified/python",
  "model": "/path/to/the/qualified/TinyCLIP/snapshot"
}
```

Relative setup paths resolve from the workspace at first use. The worker is fixed repository code; requests cannot choose executables or process arguments. This setup is not an OS sandbox. Use a trusted Python environment.

The selected checkpoint is `wkcn/TinyCLIP-ViT-39M-16-Text-19M-YFCC15M`, revision `07a4b0bc751cb64fecd2b661c048c1dd98d69444`. Weight SHA256 is `112bdfb07ebc8994e9afba7a2a314e278493a675033595cf48e54cf8a17ae587`. The worker also verifies the exact config, image processor and tokenizer hashes pinned in its source. Extra processor/tokenizer configs are refused.

This installation reuses the already reviewed local Python environment: Python 3.14.4, Torch 2.11.0+cu128, Transformers 5.9.0 and Pillow 12.3.0, on the RTX 3060 Laptop GPU. CUDA is required for this qualified path. No CPU fallback, runtime installation, model download, remote code or paid service is enabled. Missing setup fails with guidance.

The publisher's pinned model card declares MIT and links Microsoft's MIT license. Keep attribution when redistributing; downloaded weights are not bundled with this extension.

## Warm runtime and limits

One owned offline Python worker keeps the model warm. It caches up to 128 exact condition strings using LRU eviction; thresholds are applied separately and do not change embeddings. Image preprocessing and encoding run per call; there is no image-result cache or score softmax.

Up to eight calls are serialized. A request has a 60-second execution timeout. Abort, timeout, closing `computer:session` and session shutdown stop the owned worker; no request is replayed. Queued requests cancelled by close do not restart it. Later calls may start a fresh worker. This does not close application windows or change the CUA runtime.

Wording, negation, scale and distractors can change similarity. Prior research found overlapping positive/negative scores for “Is a mole visible?” and for a wooden log. Raising the model size did not make arbitrary natural-language predicates reliable. Choose thresholds deliberately; test positives and hard negatives and retain unknown for borderline scores. Unknown is a **numerical band**, not a promise that all semantic uncertainty has been detected.

See [the earlier negative experiments](research/larger-mole-negative-checks.md).
