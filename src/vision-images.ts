import { createHash } from "node:crypto";
import sharp from "sharp";

/** Supported spatial resampling kernels; encoding stays PNG for this comparison. */
export const visionKernels = ["lanczos2", "lanczos3", "mitchell", "mks2021"] as const;
/** One immutable settings version, captured before an observation starts. */
export interface VisionSettings {
  kernel: typeof visionKernels[number]; maxLongEdge: number; scale: number; version: number;
}
/** Actual image dimensions and the transform back to source CSS pixels. */
export interface AgentImage {
  configuration: VisionSettings; cap: number;
  source: { hash: string; width: number; height: number; bytes: number };
  sourceCss?: { width: number; height: number };
  output: { hash: string; width: number; height: number; bytes: number };
  mapping: { offsetX: number; offsetY: number; scaleX: number; scaleY: number };
  timings: { decode_ms: number; resample_ms: number; encode_ms: number; total_ms: number };
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const defaults = (): VisionSettings => ({ kernel: "mks2021", maxLongEdge: 500, scale: 1, version: 0 });
const maxBytes = 12 * 1024 * 1024;

/** Validate settings without changing a session or exposing policy controls. */
export function validateVisionSettings(value: unknown): Omit<VisionSettings, "version"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected image settings.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "kernel,maxLongEdge,scale" ||
    !visionKernels.includes(input.kernel as VisionSettings["kernel"]) ||
    !Number.isInteger(input.maxLongEdge) || (input.maxLongEdge as number) < 64 || (input.maxLongEdge as number) > 4096 ||
    typeof input.scale !== "number" || !Number.isFinite(input.scale) || input.scale < 0.05 || input.scale > 1)
    throw new Error("Use a supported kernel, long edge 64..4096 and scale 0.05..1.");
  return { kernel: input.kernel as VisionSettings["kernel"], maxLongEdge: input.maxLongEdge as number, scale: input.scale };
}

/** Session-scoped settings and bounded original PNG resources, separate from model output. */
export class VisionImages {
  private current = defaults();
  private originals = new Map<string, Buffer>();

  /** Return a copy so in-flight captures cannot be changed by subsequent panel edits. */
  settings(): VisionSettings { return { ...this.current }; }

  /** Validate a complete settings tuple before applying it atomically. No policy controls. */
  update(value: unknown): VisionSettings {
    this.current = { ...validateVisionSettings(value), version: this.current.version + 1 };
    return this.settings();
  }

  /** Reset at a new session/reload, never rewrite historical agent frames. */
  reset(): void { this.current = defaults(); this.originals.clear(); }

  /** Retrieve only a retained original by hash; no filesystem paths or external downloads. */
  asset(id: string): Buffer | undefined { return this.originals.get(id); }

  /** Resize fresh source pixels once, fit the whole view, never enlarge, and report actual PNG sizes. */
  async process(png: string, configuration: VisionSettings,
    region?: { x: number; y: number }): Promise<{ png: string; metadata: AgentImage }> {
    const started = performance.now();
    if (png.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(png)) throw new Error("Source PNG exceeds the image limit or is malformed.");
    const original = Buffer.from(png, "base64");
    const options = { limitInputPixels: 32_000_000, failOn: "error" as const };
    const info = await sharp(original, options).metadata();
    if (info.format !== "png" || !info.width || !info.height) throw new Error("Expected one source PNG.");
    const decoded = await sharp(original, options).raw().toBuffer({ resolveWithObject: true });
    const decodedAt = performance.now();
    const cap = Math.max(1, Math.floor(configuration.maxLongEdge * configuration.scale));
    const longEdge = Math.max(info.width, info.height);
    const width = Math.max(1, Math.min(info.width, Math.floor(info.width * cap / longEdge)));
    const height = Math.max(1, Math.min(info.height, Math.floor(info.height * cap / longEdge)));
    // Materialize resampled pixels before encoding so stage timings do not conflate both.
    const raw = await sharp(decoded.data, { raw: { width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels } })
      .resize(width, height, { fit: "fill", withoutEnlargement: true,
      kernel: configuration.kernel, fastShrinkOnLoad: false }).raw().toBuffer({ resolveWithObject: true });
    const resizedAt = performance.now();
    const output = await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } })
      .png({ compressionLevel: 6 }).toBuffer();
    const encodedAt = performance.now();
    const sourceHash = hash(original);
    this.originals.delete(sourceHash); this.originals.set(sourceHash, original);
    let bytes = [...this.originals.values()].reduce((sum, item) => sum + item.length, 0);
    for (const [id, item] of this.originals) {
      if (this.originals.size <= 6 && bytes <= 48 * 1024 * 1024) break;
      this.originals.delete(id); bytes -= item.length;
    }
    return { png: output.toString("base64"), metadata: {
      configuration: { ...configuration }, cap,
      source: { hash: sourceHash, width: info.width, height: info.height, bytes: original.length },
      output: { hash: hash(output), width: raw.info.width, height: raw.info.height, bytes: output.length },
      mapping: { offsetX: region?.x ?? 0, offsetY: region?.y ?? 0, scaleX: info.width / raw.info.width, scaleY: info.height / raw.info.height },
      timings: { decode_ms: decodedAt - started, resample_ms: resizedAt - decodedAt, encode_ms: encodedAt - resizedAt, total_ms: encodedAt - started },
    } };
  }
}
