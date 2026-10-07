import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const workerPath = fileURLToPath(new URL("../scripts/visual-classifier-worker.py", import.meta.url));

/** Trusted local installation paths; never supplied by a classifier tool request. */
export interface ClassifierConfig { python: string; model: string }
/** A saved image or an unchanged image block from a computer-use result. No URL fetch or capture. */
export interface PredicateRequest {
  image: string | { type: "image"; data: string; mimeType: string };
  condition: string;
  threshold: number;
  uncertainty?: number;
}
/** null means a score in the caller's uncertainty band, not a runtime failure. */
export interface PredicateResult {
  status: "classified";
  value: boolean | null;
  score: number;
  threshold: number;
  uncertainty: number;
  condition: string;
  model: "TinyCLIP-39M";
  cache_hit: boolean;
  image: { sha256: string; width: number; height: number };
  timing_ms: { total: number; inference: number; load: number };
}

/** Compare a raw cosine score with the agent's cutoff. The closed band is unknown. */
export function decide(score: number, threshold: number, uncertainty = 0): boolean | null {
  if (![score, threshold, uncertainty].every(Number.isFinite) || Math.abs(score) > 1 || Math.abs(threshold) > 1 ||
    uncertainty < 0 || threshold - uncertainty < -1 || threshold + uncertainty > 1)
    throw Error("Use finite cosine scores/cutoffs in [-1,1] and an uncertainty band inside that range.");
  const delta = score - threshold;
  return Math.abs(delta) <= uncertainty + 1e-12 ? null : delta > 0;
}

/** Load explicit user-controlled setup. Missing setup never downloads or silently selects a model. */
export async function loadClassifierConfig(cwd: string): Promise<ClassifierConfig> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path.join(cwd, ".pi/visual-classifier.json"), "utf8")); }
  catch { throw Error("Configure local python and model paths in .pi/visual-classifier.json; see docs/visual-classifier.md."); }
  const config = value as Partial<ClassifierConfig>;
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(key => !["python", "model"].includes(key)) ||
    typeof config.python !== "string" || !config.python.trim() || typeof config.model !== "string" || !config.model.trim())
    throw Error("Classifier setup must contain only nonempty python and model paths.");
  return { python: path.resolve(cwd, config.python), model: path.resolve(cwd, config.model) };
}

async function pixels(input: PredicateRequest["image"], cwd: string) {
  let bytes: Buffer;
  if (typeof input === "string") {
    if (!input.trim()) throw Error("Choose a saved image path.");
    const file = await open(path.resolve(cwd, input), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw Error("Image must be a regular file of at most 10 MiB.");
      bytes = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== bytes.length) throw Error("Image changed while being read.");
    } finally { await file.close(); }
  } else {
    if (!input || input.type !== "image" || !["image/png", "image/jpeg", "image/webp"].includes(input.mimeType) ||
      typeof input.data !== "string" || input.data.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data))
      throw Error("Use a PNG/JPEG/WebP base64 image block of at most 10 MiB.");
    bytes = Buffer.from(input.data, "base64");
    if (bytes.toString("base64") !== input.data) throw Error("Image base64 is not canonical.");
  }
  if (!bytes.length || bytes.length > MAX_BYTES) throw Error("Image must contain at most 10 MiB.");
  const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
  if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1)
    throw Error("Use one PNG, JPEG or WebP frame.");
  return { bytes, image: { sha256: createHash("sha256").update(bytes).digest("hex"), width: metadata.width, height: metadata.height } };
}

/** One lazy owned worker, bounded serialized requests, and no capture or desktop input. */
export class VisualClassifier {
  private child?: ChildProcessWithoutNullStreams;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private nextId = 0;
  private generation = 0;
  private closing = false;
  private pending?: { id: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };
  constructor(private readonly config: ClassifierConfig, private readonly worker = workerPath) {}

  /** Evaluate one condition. Aborts/errors reject rather than becoming negative detections. */
  async classify(request: PredicateRequest, signal?: AbortSignal, cwd = process.cwd()): Promise<PredicateResult> {
    if (this.closing) throw Error("Classifier is closing.");
    if (this.queued >= 8) throw Error("Classifier queue is full (8 requests).");
    const generation = this.generation;
    const start = performance.now();
    this.queued++;
    const run = this.tail.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw Error("Classifier request was closed before execution.");
      if (typeof request.condition !== "string" || !request.condition.trim() || request.condition.length > 2048)
        throw Error("Provide one nonempty condition of at most 2048 characters.");
      const uncertainty = request.uncertainty ?? 0;
      decide(0, request.threshold, uncertainty);
      const source = await pixels(request.image, cwd); signal?.throwIfAborted();
      if (generation !== this.generation) throw Error("Classifier request was closed before execution.");
      const response = await this.exchange({ condition: request.condition, data: source.bytes.toString("base64") }, signal);
      const score = response.score;
      if (typeof score !== "number" || typeof response.cache_hit !== "boolean" ||
        typeof response.inference_ms !== "number" || !Number.isFinite(response.inference_ms) || response.inference_ms < 0 ||
        typeof response.load_ms !== "number" || !Number.isFinite(response.load_ms) || response.load_ms < 0)
        throw Error("Invalid classifier worker receipt.");
      return { status: "classified" as const, value: decide(score, request.threshold, uncertainty), score,
        threshold: request.threshold, uncertainty, condition: request.condition, model: "TinyCLIP-39M" as const,
        cache_hit: response.cache_hit, image: source.image,
        timing_ms: { total: performance.now() - start, inference: response.inference_ms, load: response.load_ms } };
    });
    this.tail = run;
    try { return await run; } finally { this.queued--; }
  }

  private exchange(body: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (!this.child) {
      const child = spawn(this.config.python, [this.worker, this.config.model], {
        env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false" },
        stdio: "pipe",
      });
      this.child = child; let buffer = "";
      const fail = (error: Error) => { if (this.child === child) { this.pending?.reject(error); this.pending = undefined; child.kill(); } };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 8192) return fail(Error("Classifier worker output exceeded its bound."));
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            if (!this.pending || response.id !== this.pending.id) throw Error("Classifier worker response identity mismatch.");
            const pending = this.pending; this.pending = undefined;
            if (typeof response.error === "string") pending.reject(Error(response.error)); else pending.resolve(response);
          } catch { fail(Error("Invalid classifier worker protocol.")); }
        }
      });
      // Library startup messages are not image results or unbounded retained logs.
      child.stderr.resume();
      child.stdin.on("error", () => fail(Error("Classifier worker input failed.")));
      child.on("error", () => fail(Error("Cannot start the configured classifier Python runtime.")));
      child.on("close", () => { if (this.child === child) { this.child = undefined; this.pending?.reject(Error("Classifier worker exited before its receipt.")); this.pending = undefined; } });
    }
    const child = this.child;
    if (child.killed) return Promise.reject(Error("Previous classifier worker shutdown is unconfirmed."));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const stop = (error: Error) => { cleanup(); this.pending = undefined; void this.stopWorker(child).then(() => reject(error), reject); };
      const abort = () => stop(Error("Classifier request aborted; no result was produced."));
      const timer = setTimeout(() => stop(Error("Classifier request timed out after 60 seconds.")), 60_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      this.pending = { id, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { cleanup(); abort(); return; }
      child.stdin.write(JSON.stringify({ id, ...body }) + "\n", error => { if (error) this.pending?.reject(Error("Classifier worker input failed.")); });
    });
  }

  private async stopWorker(child = this.child): Promise<void> {
    if (!child) return;
    if (this.child === child) { this.pending?.reject(Error("Classifier worker closed.")); this.pending = undefined; }
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Classifier worker shutdown is unconfirmed.")), 2000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGKILL");
    });
  }

  /** Release only the owned model worker. Future calls may start a fresh one. */
  async close(): Promise<void> {
    this.closing = true; this.generation++;
    try { await this.stopWorker(); await this.tail.catch(() => undefined); }
    finally { this.closing = false; }
  }
}
