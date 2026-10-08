import { createHash } from "node:crypto";

/** Provider identity at Pi's existing, mutable application-boundary hook. */
export interface VisionModel { provider: string; api: string; model: string }
interface ImageBytes { bytes: Buffer; mime: string; hash: string; width?: number; height?: number }
interface SequenceMatch { sequence_id: string; index: number; timestamp_ms: number }
interface Frame {
  id: string; hash: string; mime: string; bytes: number; width?: number; height?: number;
  time: string; stage: "captured" | "prepared" | "evicted"; finalDelivery: "unconfirmed";
  original: "available" | "unavailable"; originalHash?: string; actionId?: string; matchingActionIds?: string[]; requestId?: string; path?: string; detail?: string;
  source?: unknown; configuration?: unknown;
  sequenceFrame?: SequenceMatch;
}
interface Action {
  id: string; parentId?: string; tool: string; input: unknown; time: string; started: number;
  durationMs?: number; status: string; isError?: boolean; text?: string; adapterStructure?: unknown;
}
interface Request extends VisionModel {
  id: string; time: string; imageCount: number; unavailableImages: number;
  texts: { path: string; text: string }[]; textTruncated: boolean;
  frameIds: string[]; finalPayload: "unconfirmed"; responseStatus?: number;
  sequenceImages: { hash: string; path: string; matches: SequenceMatch[]; available?: boolean }[];
}
const limitations = [
  "Final delivery is unconfirmed: later handlers can replace this application-boundary payload.",
  "Codex WebSocket may send a delta; wire payload and effective server context are not observed.",
  "The three-card viewer does not limit the model context.",
  "Native CUA exposes returned PNG/JPEG bytes, not retained full-resolution originals.",
  "Native JPEG dimensions are reported by matching adapter metadata. Provider-internal resize and final delivery are unobserved.",
  "Action links match image bytes; identical screenshots can have more than one source.",
];
const maxImageBytes = 12 * 1024 * 1024;
const maxAssetBytes = 48 * 1024 * 1024;

function imageBytes(data: string, mime: string): ImageBytes | undefined {
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime) ||
    data.length > Math.ceil(maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > maxImageBytes) return;
  const png = mime === "image/png" && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { bytes, mime, hash: createHash("sha256").update(bytes).digest("hex"),
    ...(png ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : {}) };
}
function dataUrl(value: unknown): ImageBytes | undefined {
  if (typeof value !== "string") return;
  const match = /^data:(image\/[a-z]+);base64,([\s\S]*)$/.exec(value);
  return match ? imageBytes(match[2], match[1]) : undefined;
}
/** Bound adapter metadata, strip image data and common secret fields, and reject cycles. */
function metadata(value: unknown): unknown {
  try {
    const json = JSON.stringify(value, function (key, item) {
      // A source's image field is geometry, not an image payload.
      if (key === "image" && ["windows-host", "linux-host", "macos-host"].includes(this.domain) && ["display", "window", "browser"].includes(this.kind)) return item;
      return ["image", "png", "data", "authorization", "apiKey", "access_token", "refresh_token", "password"].includes(key) ? undefined : item;
    });
    if (json === undefined) return undefined;
    return json.length <= 32_000 ? JSON.parse(json) : { truncated: true, excerpt: json.slice(0, 32_000) };
  } catch { return { unavailable: "Metadata could not be serialized." }; }
}

/** Bounded, session-local mirror. Never mutates context or asserts confirmed transport delivery. */
export class VisionTrace {
  private frames: Frame[] = [];
  private captures: Frame[] = [];
  private actions: Action[] = [];
  private requests: Request[] = [];
  private assets = new Map<string, ImageBytes>();
  private originals: string[] = [];
  private sequence = 0;
  private revision = 0;
  constructor(private sessionId: string) {}

  /** Drop all previous-session pixels, metadata and correlation state. */
  reset(sessionId: string): void {
    this.sessionId = sessionId;
    this.frames = []; this.captures = []; this.actions = []; this.requests = [];
    this.assets.clear(); this.originals = []; this.sequence = 0; this.revision++;
  }

  /** Keep recent raw returned captures and visible-card comparisons within the asset budget; never send another image. */
  retainOriginal(value: { type: string; data?: string; mimeType?: string }): void {
    if (value.type !== "image" || typeof value.data !== "string" || typeof value.mimeType !== "string") return;
    const image = imageBytes(value.data, value.mimeType);
    if (!image) return;
    this.assets.set(image.hash, image);
    this.originals = [...this.originals.filter(hash => hash !== image.hash), image.hash].slice(-3);
    this.prune();
  }
  /** Record a computer-use call, including its Codemode parent when available. */
  startAction(id: string, tool: string, input: unknown, parentId?: string): void {
    this.actions.push({ id, parentId, tool, input: metadata(input), time: new Date().toISOString(), started: performance.now(), status: "running" });
    this.actions = this.actions.slice(-100); this.revision++;
  }

  /** Record adapter output separately from what a parent script forwards to the model. */
  finishAction(id: string, content: readonly unknown[], details: unknown, isError: boolean): void {
    const action = this.actions.find(item => item.id === id);
    if (!action) return;
    action.durationMs = performance.now() - action.started;
    action.isError = isError;
    action.adapterStructure = metadata(details);
    const state = details && typeof details === "object" ? details as Record<string, unknown> : {};
    action.status = typeof state.status === "string" ? state.status : isError ? "error" : "completed";
    action.text = content.map(block => {
      const value = block as Record<string, unknown>;
      return value?.type === "text" && typeof value.text === "string" ? value.text : "";
    }).filter(Boolean).join("\n").slice(0, 16_000);
    const reported = state.agent_image as { output?: { hash?: unknown; width?: unknown; height?: unknown }; route?: unknown; coordinate_space?: unknown; native?: unknown; origin?: unknown } | undefined;
    const annotation = (state.agent_image as { annotation?: { raw?: { hash?: unknown } } } | undefined)?.annotation;
    const rawHash = annotation?.raw?.hash;
    const originalHash = typeof rawHash === "string" && this.assets.has(rawHash) ? rawHash : undefined;
    const selectedFrames = Array.isArray(state.selected_frames) ? state.selected_frames as { index: number; timestamp_ms: number; source?: unknown }[] : [];
    const sequenceId = (action.input as { sequence_id?: string } | undefined)?.sequence_id;
    let imageIndex = 0;
    for (const block of content) {
      const value = block as Record<string, unknown>;
      if (value?.type !== "image" || typeof value.data !== "string" || typeof value.mimeType !== "string") continue;
      const image = imageBytes(value.data, value.mimeType);
      const temporal = selectedFrames[imageIndex++];
      if (!image) continue;
      // JPEG geometry comes from matching native output metadata, not a new decoder.
      if (reported?.output?.hash === image.hash) {
        const { width, height } = reported.output;
        if (Number.isSafeInteger(width) && (width as number) > 0 && Number.isSafeInteger(height) && (height as number) > 0) {
          image.width ??= width as number; image.height ??= height as number;
        }
      }
      this.assets.set(image.hash, image);
      this.captures.push({ ...this.frame(image, "captured"), actionId: id, ...(originalHash ? { original: "available", originalHash } : {}),
        ...(temporal && sequenceId ? { sequenceFrame: { sequence_id: sequenceId, index: temporal.index, timestamp_ms: temporal.timestamp_ms } } : {}),
        source: metadata({ observation: temporal?.source ?? state.source, tab: state.tab, window_ref: state.window_ref, observation_id: state.observation_id, screenshot: state.screenshot, origin: reported?.origin, route: reported?.route, coordinate_space: reported?.coordinate_space, native: reported?.native, annotation }),
        configuration: metadata({ requested: action.input, effective: state.agent_image ?? "unreported by current adapter", timings: state.timings }) });
      this.captures = [...this.captures.filter(f => f.sequenceFrame).slice(-40), ...this.captures.filter(f => !f.sequenceFrame).slice(-3)];
    }
    this.prune(); this.revision++;
  }

  private frame(image: ImageBytes, stage: Frame["stage"]): Frame {
    return { id: `frame-${++this.sequence}`, hash: image.hash, mime: image.mime, bytes: image.bytes.length,
      width: image.width, height: image.height, time: new Date().toISOString(), stage,
      finalDelivery: "unconfirmed", original: "unavailable" };
  }

  /** Snapshot the existing hook payload, not final HTTP bytes or provider embeddings. */
  observePayload(payload: unknown, model: VisionModel): void {
    const request: Request = { ...model, id: `request-${++this.sequence}`, time: new Date().toISOString(), imageCount: 0,
      unavailableImages: 0, texts: [], textTruncated: false, frameIds: [], sequenceImages: [], finalPayload: "unconfirmed" };
    const selected: { image: ImageBytes; path: string; detail?: string }[] = [];
    let nodes = 0;
    let textBytes = 0;
    const seen = new WeakSet<object>();
    const visit = (value: unknown, path: string, depth: number): void => {
      if (!value || typeof value !== "object" || depth > 40 || ++nodes > 100_000 || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1)); seen.delete(value); return; }
      const node = value as Record<string, unknown>;
      let image: ImageBytes | undefined;
      const inline = (node.inlineData ?? node.inline_data) as Record<string, unknown> | undefined;
      const isImage = ["input_image", "image_url", "image"].includes(String(node.type)) || !!inline;
      if (isImage) {
        request.imageCount++;
        const source = node.source as Record<string, unknown> | undefined;
        if (typeof node.image_url === "string") image = dataUrl(node.image_url);
        else if (node.image_url && typeof node.image_url === "object") image = dataUrl((node.image_url as Record<string, unknown>).url);
        else if (source?.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") image = imageBytes(source.data, source.media_type);
        else if (inline && typeof inline.data === "string") image = imageBytes(inline.data, String(inline.mimeType ?? inline.mime_type));
        else if (typeof node.data === "string" && typeof node.mimeType === "string") image = imageBytes(node.data, node.mimeType);
        if (image) {
          selected.push({ image, path, detail: typeof node.detail === "string" ? node.detail : undefined });
          const matches = [...new Map(this.captures.filter(f => f.hash === image!.hash && f.sequenceFrame)
            .map(f => { const frame = f.sequenceFrame!; return [`${frame.sequence_id}:${frame.index}`, frame] as const; })).values()];
          if (matches.length) {
            request.sequenceImages.push({ hash: image.hash, path, matches });
            request.sequenceImages = request.sequenceImages.slice(-40);
            this.assets.set(image.hash, image);
          }
          if (selected.length > 3) selected.shift();
        } else request.unavailableImages++;
        seen.delete(value); return;
      }
      const candidate = ["input_text", "output_text", "text"].includes(String(node.type)) ? node.text
        : ["function_call_output", "custom_tool_call_output"].includes(String(node.type)) ? node.output
        : node.role === "tool" && typeof node.content === "string" ? node.content : undefined;
      if (typeof candidate === "string") {
        const excerpt = candidate.slice(0, 16_000);
        if (excerpt) request.texts.push({ path, text: excerpt });
        textBytes += excerpt.length;
        while (textBytes > 64_000) {
          textBytes -= request.texts.shift()!.text.length;
          request.textTruncated = true;
        }
        if (excerpt.length !== candidate.length) request.textTruncated = true;
      }
      for (const [key, item] of Object.entries(node)) visit(item, `${path}.${key}`, depth + 1);
      seen.delete(value);
    };
    visit(payload, "$", 0);
    if (nodes > 100_000) request.textTruncated = true;
    for (const { image, path, detail } of selected) {
      const matches = this.captures.filter(item => item.hash === image.hash);
      const capture = matches.length === 1 ? matches[0] : undefined;
      const frame = { ...this.frame(image, "prepared"), width: image.width ?? capture?.width, height: image.height ?? capture?.height, actionId: capture?.actionId, source: capture?.source,
        configuration: capture?.configuration, original: capture?.original ?? "unavailable", originalHash: capture?.originalHash, matchingActionIds: matches.map(item => item.actionId!).filter(Boolean), requestId: request.id, path, detail };
      this.assets.set(image.hash, image);
      this.frames.push(frame); request.frameIds.push(frame.id);
    }
    this.frames = this.frames.slice(-3);
    this.requests.push(request); this.requests = this.requests.slice(-20);
    this.prune(); this.revision++;
  }

  /** A provider response is useful evidence, but not proof of unchanged image delivery. */
  response(status: number): void {
    const request = this.requests.at(-1);
    if (request) { request.responseStatus = status; this.revision++; }
  }

  private prune(): void {
    const retained = new Set([...this.originals, ...(this.requests.at(-1)?.sequenceImages.map(f => f.hash) ?? []),
      ...[...this.frames, ...this.captures].flatMap(frame => [frame.hash, ...(frame.originalHash ? [frame.originalHash] : [])])]);
    for (const hash of this.assets.keys()) if (!retained.has(hash)) this.assets.delete(hash);
    let size = [...this.assets.values()].reduce((sum, image) => sum + image.bytes.length, 0);
    for (const [hash, image] of this.assets) {
      if (size <= maxAssetBytes) break;
      this.assets.delete(hash); size -= image.bytes.length;
    }
    for (const frame of [...this.frames, ...this.captures]) {
      if (!this.assets.has(frame.hash)) frame.stage = "evicted";
      if (frame.originalHash && !this.assets.has(frame.originalHash)) frame.original = "unavailable";
    }
  }

  /** Return retained bytes only; never download an external image URL. */
  asset(hash: string): Buffer | undefined { return this.assets.get(hash)?.bytes; }
  /** Content type for a retained image asset. */
  assetMime(hash: string): string | undefined { return this.assets.get(hash)?.mime; }
  /** JSON-safe viewer state without image base64. Retained UI text can still be sensitive. */
  snapshot() {
    return structuredClone({ sessionId: this.sessionId, revision: this.revision, limitations,
      frames: this.frames, captures: this.captures, actions: this.actions,
      requests: this.requests.map(request => ({ ...request, sequenceImages: request.sequenceImages.map(f => ({ ...f, available: this.assets.has(f.hash) })) })) });
  }
}
