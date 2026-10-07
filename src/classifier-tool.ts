import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VisualClassifier, loadClassifierConfig } from "./visual-classifier.ts";

/** Register a read-only predicate tool. The returned close function owns only its model worker. */
export function registerClassifierTool(pi: ExtensionAPI,
  factory: (cwd: string) => Promise<VisualClassifier> = async cwd => new VisualClassifier(await loadClassifierConfig(cwd))): () => Promise<void> {
  let loading: Promise<VisualClassifier> | undefined;
  let closing: Promise<void> | undefined;
  const region = Type.Object({
    x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }),
    width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false });
  const common = {
    status: Type.Literal("classified"),
    threshold: Type.Number(), uncertainty: Type.Number(), condition: Type.String(),
    model: Type.Literal("TinyCLIP-39M"), cache_hit: Type.Boolean(),
    image: Type.Object({ sha256: Type.String(), width: Type.Number(), height: Type.Number() }),
    timing_ms: Type.Object({ total: Type.Number(), inference: Type.Number(), load: Type.Number() }),
  };
  const decision = { value: Type.Union([Type.Boolean(), Type.Null()]), score: Type.Number() };
  const schema = Type.Union([
    Type.Object({ ...common, ...decision, region: Type.Optional(region) }),
    Type.Object({ ...common, results: Type.Array(Type.Object({ ...decision, region }), { minItems: 1, maxItems: 16 }) }),
  ]);
  pi.registerTool({
    name: "computer_classify", label: "Visual condition",
    description: "Evaluate ONE visual condition on supplied pixels with local TinyCLIP-39M; no capture, input, paid call, opposite description or state list. image is a saved path or an unchanged image block from computer_observe/computer_sequence. Optional region is a positive integer rectangle in that supplied image, cropped in memory without another capture; outside bounds and EXIF-rotated region input reject. Alternatively, regions contains 1..16 rectangles evaluated as ONE image-encoder batch with the same condition and cutoff; results are ordered independent value/score/region records, not an aggregate boolean. Choose region or regions, never both. Total crop area is at most 16 million pixels. Classification does not consume or renew observation authority. condition is one text description or question. The agent MUST choose threshold for that wording/domain; cosine is NOT a probability and free-form questions/negation may be unreliable. value is true above threshold+uncertainty, false below threshold-uncertainty, null (unknown) inside the closed band; uncertainty defaults to 0 and an exact tie stays unknown. In Codemode branch with value === true/false; do not treat null as false. Errors throw, never become detections. Model stays warm and caches up to 128 condition embeddings. computer_close or session shutdown releases it. Setup: docs/visual-classifier.md.",
    parameters: Type.Object({
      image: Type.Union([Type.String({ minLength: 1 }), Type.Object({ type: Type.Literal("image"), data: Type.String({ minLength: 1, maxLength: 13981016 }),
        mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")]) }, { additionalProperties: false })]),
      region: Type.Optional(region),
      regions: Type.Optional(Type.Array(region, { minItems: 1, maxItems: 16 })),
      condition: Type.String({ minLength: 1, maxLength: 2048 }),
      threshold: Type.Number({ minimum: -1, maximum: 1 }),
      uncertainty: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }, { additionalProperties: false }),
    outputSchema: schema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      if (closing) throw Error("Classifier is closing.");
      if (!loading) loading = factory(ctx.cwd).catch(error => { loading = undefined; throw error; });
      const classifier = await loading;
      const result = params.regions !== undefined
        ? await classifier.classify({ ...params, regions: params.regions }, signal, ctx.cwd)
        : await classifier.classify(params, signal, ctx.cwd);
      const summary = "results" in result
        ? `Visual batch: ${result.results.length} regions`
        : `Visual condition: ${result.value === null ? "unknown" : result.value}`;
      return { content: [{ type: "text", text: `${summary}\n${JSON.stringify(result)}` }],
        details: result, structuredContent: JSON.parse(JSON.stringify(result)) };
    },
  });
  return async () => {
    closing ??= (async () => { await (await loading)?.close(); loading = undefined; })();
    try { await closing; } finally { closing = undefined; }
  };
}
