import { randomUUID, createHash } from "node:crypto";
import { collectSequence, cropSequenceFrame, frameSummary, selectFrames, sequenceMetadata, SequenceStop, SequenceStore, validateSequence, type SequenceOptions, type FrameSelection, type SequenceFrame } from "./temporal-capture.ts";
import type { GuideMark } from "./image-guides.ts";
import { createUiResource, projectUi, resolveUi, annotateUi, validateUiCapture, type UiResource, type UiRequest, type UiCaptureOptions } from "./ui-resources.ts";
import { nativeInput, requestedInputTime, validateInput, type InputCommand, type InputStep } from "./complete-input.ts";
import { notifyWindowObserver, notifyHighlight, type WindowObserver, type HighlightResult } from "./window-overlay.ts";
import { screenRect, elementRegion, windowImageMapping, windowRegion, nativeClickPoint, type ScreenRect } from "./highlight-geometry.ts";
import { observationSource, sourceIdentity, type ObservationSource, type SourceIdentity } from "./observation-source.ts";
import { actionCapability, type ActionCapability } from "./action-capability.ts";
import { nativeImageCap, type CuaVisionSettings } from "./cua-image-settings.ts";
import { setTimeout as delay } from "node:timers/promises";
import { cropDisplay, nativeRegion, validateDetail, type DetailContext, type DetailRequest } from "./native-detail.ts";

/** Native Windows address. Models use session window references instead. */
export interface WindowTarget { pid: number; window_id: number }
/** Safe limits UI access to individually opened session windows; neither mode is an OS sandbox. */
export type ComputerMode = "safe" | "yolo";
/** Model-visible native text or screenshot. */
export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
/** Native MCP result; structured state is separate from images. */
export interface DriverResult {
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** Owned backend with window-lifetime checks. Calls are serialized by ComputerSession. */
export interface Driver {
  /** True only for a backend qualified for held paths and graceful in-flight release. */
  heldPaths?: boolean;
  /** True only for a qualified native runtime with bounded keyboard ownership. */
  heldKeys?: boolean;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult>;
  identity(target: WindowTarget, create: boolean, signal?: AbortSignal): Promise<string | undefined>;
  close(): Promise<void>;
}
/** One complete action or bounded known-target sequence, grounded in one window overview. */
export type Action = {
  window_ref: string;
  observation_id: string;
  delivery_mode?: "background" | "foreground";
} & (InputCommand | { action: "sequence"; sequence: InputStep[] });
/** Delivery is not a task postcondition. Unknown input is never automatically replayed. */
export interface ComputerResult {
  content: Content[];
  details: {
    status: "listed" | "observed" | "delivered" | "refused" | "unknown" | "closed";
    mode: ComputerMode;
    target?: WindowTarget;
    window_ref?: string;
    observation_id?: string;
    opened?: boolean;
    state?: Record<string, unknown>;
    source?: ObservationSource;
    source_identity?: SourceIdentity;
    action_capability?: ActionCapability;
    agent_image?: Record<string, unknown>;
    highlight?: HighlightResult;
    ui?: UiResource;
    sequence?: ReturnType<typeof sequenceMetadata>;
    selected_frames?: Omit<SequenceFrame, "image">[];
  };
  isError?: boolean;
}
interface Observation { id: string; tokens: Set<string>; width?: number; height?: number; captureId?: string; bounds?: ScreenRect; frames: Map<string, ScreenRect>; ui: UiResource; rawImage?: Content; source?: ObservationSource; settings: CuaVisionSettings; region?: ScreenRect; actionMark?: GuideMark; mapping?: DetailContext["windowMapping"] }
interface WindowEntry { ref: string; target: WindowTarget; identity: string; owned: boolean; observation?: Observation; detail?: DetailContext; lastAction?: GuideMark }
interface App { name: string; launch_path?: string; bundle_id?: string; kind?: string }
const appName = (name: string) => name.trim().toLowerCase().replace(/^windows\s+/, "").replace(/\.exe$/, "");

/** Multi-window UI policy. Native work is queued; ownership and observations are not persisted across reloads. */
export class ComputerSession {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, WindowEntry>();

  private readonly sessionId = randomUUID();
  private displayOverview?: DetailContext;
  private readonly sequences = new SequenceStore();
  private uiSerial = 0;
  private uiImages: Observation[] = [];

  private geometry(state: Record<string, unknown>, display: boolean): string {
    if (display) return JSON.stringify([state.screen_width, state.screen_height, state.scale_factor]);
    const bounds = state.window_bounds as Record<string, unknown> | undefined;
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(v => typeof v === "number" && Number.isFinite(v)) ||
      (bounds.width as number) <= 0 || (bounds.height as number) <= 0) throw new Error("Window geometry is missing.");
    return JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height]);
  }

  private overview(state: Record<string, unknown>, id: string, display: boolean, images: Content[]): DetailContext | undefined {
    const width = state.screenshot_width as number; const height = state.screenshot_height as number;
    const originalWidth = (state.screenshot_original_width ?? (display ? state.screen_width : width)) as number;
    const originalHeight = (state.screenshot_original_height ?? (display ? state.screen_height : height)) as number;
    if (![width, height, originalWidth, originalHeight].every(v => Number.isSafeInteger(v) && v > 0)) return;
    const image = images.length === 1 ? images[0] : undefined;
    if (image?.type !== "image" || image.mimeType !== "image/png") return;
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) return;
    try { return { id, width, height, originalWidth, originalHeight, geometry: this.geometry(state, display), ...(!display ? { windowMapping: windowImageMapping(state) } : {}) }; }
    catch { return undefined; }
  }

  constructor(private readonly driver: Driver, private readonly getMode: () => ComputerMode = () => "yolo",
    private readonly settings: () => CuaVisionSettings = () => ({ kernel: "lanczos3", maxLongEdge: 500, scale: 1, version: 0, route: "cua_native" }),
    private readonly observer?: WindowObserver,
    private readonly retainRaw?: (image: Content) => void) {}

  private queue(work: () => Promise<ComputerResult>): Promise<ComputerResult> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private result(status: ComputerResult["details"]["status"], message: string,
    state?: Record<string, unknown>, extra: Partial<ComputerResult["details"]> = {}, images: Content[] = []): ComputerResult {
    const details = { ...extra, status, mode: this.getMode(), ...(state ? { state } : {}) };
    // Codemode gets the full structured resource. Plain tool text is a bounded, valid JSON projection.
    const visibleUi = extra.ui && { ...extra.ui, elements: extra.ui.elements.slice(0, 30).map(e => ({ ...e,
      name: e.name?.slice(0, 128) ?? null, value: e.value?.slice(0, 128) ?? null,
      text_truncated: e.text_truncated || (e.name?.length ?? 0) > 128 || (e.value?.length ?? 0) > 128 })) };
    const projection = visibleUi && { ui_elements: visibleUi.elements.length, full_ui_elements: extra.ui!.elements.length,
      note: "Plain text shows at most 30 elements with 128-character names/values. Use structured ui or local search/scope for the rest." };
    const display = extra.sequence ? { ...details, sequence: { ...extra.sequence, source: extra.sequence.frames[0]?.source,
      frames: extra.sequence.frames.map(frameSummary) }, text_projection: { note: "Frame summaries only; full per-frame source metadata is in the structured sequence resource." } }
      : extra.selected_frames ? { ...details, source: extra.selected_frames[0]?.source, selected_frames: extra.selected_frames.map(frameSummary),
        text_projection: { note: "Frame summaries only; full per-frame source metadata accompanies each structured frame." } }
      : visibleUi ? { ...details, ui: visibleUi, text_projection: projection,
      state: state && Object.fromEntries(Object.entries(state).filter(([key]) => !["elements", "tree_markdown", "_note"].includes(key))),
      agent_image: extra.agent_image && { ...extra.agent_image, annotation: extra.agent_image.annotation && {
        ...(extra.agent_image.annotation as Record<string, unknown>), labels: undefined } } } : details;
    const pretty = JSON.stringify(display, null, 2);
    const json = pretty.length <= 24_000 ? pretty : JSON.stringify(display);
    const visible = json.length <= 24_000 ? json : extra.sequence || extra.selected_frames ? JSON.stringify({ ...details,
      ...(extra.sequence ? { sequence: { ...extra.sequence, source: extra.sequence.frames[0]?.source, frames: extra.sequence.frames.slice(0, 5).map(frameSummary) } } : {}),
      ...(extra.selected_frames ? { selected_frames: extra.selected_frames.slice(0, 5).map(frameSummary) } : {}),
      text_projection: { note: "Plain text shows five frame summaries. Full metadata is available in the structured result.", metadata_omitted: true } })
      : visibleUi ? JSON.stringify({ status, mode: details.mode,
      window_ref: extra.window_ref, observation_id: extra.observation_id,
      agent_image: extra.agent_image && { image_id: extra.agent_image.image_id, output: extra.agent_image.output },
      ui: { ...visibleUi, elements: visibleUi.elements.slice(0, 5) },
      text_projection: { ...projection, ui_elements: Math.min(5, visibleUi.elements.length), metadata_omitted: true } })
      : json.slice(0, 24_000) + "\n[Text truncated; narrow the observation.]";
    const mark = extra.highlight;
    const where = mark?.region ? `; screen region ${mark.region.x},${mark.region.y} ${mark.region.width}x${mark.region.height}`
      : mark?.point ? `; screen point ${mark.point.x},${mark.point.y}` : "";
    const summary = mark ? `\nHuman mark: ${mark.kind ?? "target"} ${mark.status}${where}${mark.reason ? ` (${mark.reason})` : ""}.` : "";
    return { content: [{ type: "text", text: `${message}${summary}\n${visible}` }, ...images], details,
      ...(["refused", "unknown"].includes(status) ? { isError: true } : {}) };
  }

  private allowed(entry: WindowEntry): boolean {
    return this.getMode() === "yolo" || entry.owned;
  }

  private denied(ref: string): ComputerResult {
    return this.result("refused", "Safe mode allows only windows opened by this session. Only the user can change mode with /computer-mode.",
      undefined, { window_ref: ref });
  }

  private addressed(entry: WindowEntry): Partial<ComputerResult["details"]> {
    return { target: entry.target, window_ref: entry.ref,
      source_identity: sourceIdentity({ session_id: this.sessionId, window_ref: entry.ref, ...entry.target }) };
  }

  private async failed(error: unknown, dispatched: boolean): Promise<ComputerResult> {
    this.entries.clear(); this.displayOverview = undefined; this.uiImages = []; this.sequences.clear();
    await this.driver.close().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    return this.result(dispatched ? "unknown" : "refused", dispatched
      ? `Outcome unknown: the application may have changed. Discover and observe before deciding; do not replay blindly. ${reason}`
      : `Computer use failed before input dispatch. Discover again. ${reason}`);
  }

  private async state(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const native = await this.driver.call(name, args, signal);
    if (native.isError) throw new Error(JSON.stringify(native.structuredContent ?? native.content));
    if (native.structuredContent) return native.structuredContent;
    for (const block of native.content) {
      if (block.type !== "text") continue;
      try {
        const parsed = JSON.parse(block.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      } catch { /* Not every native diagnostic is JSON. */ }
    }
    throw new Error(`Driver returned no structured ${name} result.`);
  }

  private async register(target: WindowTarget, signal?: AbortSignal): Promise<WindowEntry | undefined> {
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !Number.isSafeInteger(target.window_id) || target.window_id <= 0)
      return undefined;
    const identity = await this.driver.identity(target, true, signal);
    if (!identity) return undefined;
    for (const entry of this.entries.values()) {
      if (entry.target.pid === target.pid && entry.target.window_id === target.window_id && entry.identity === identity) return entry;
    }
    const entry: WindowEntry = { ref: "w-" + randomUUID(), target: { pid: target.pid, window_id: target.window_id }, identity, owned: false };
    this.entries.set(entry.ref, entry);
    return entry;
  }

  private async current(ref: string, signal?: AbortSignal): Promise<WindowEntry | undefined> {
    const entry = this.entries.get(ref);
    if (!entry || !this.allowed(entry)) return undefined;
    if (await this.driver.identity(entry.target, false, signal) === entry.identity) return this.allowed(entry) ? entry : undefined;
    this.entries.delete(ref);
    return undefined;
  }

  private async list(signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const state = await this.state("list_windows", {}, signal);
    if (!Array.isArray(state.windows)) throw new Error("Driver returned no window list.");
    return state.windows as Record<string, unknown>[];
  }

  /** Discover permitted window metadata. Safe never adopts outside-session windows or grants their same-PID siblings. */
  windows(signal?: AbortSignal, query?: string): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before discovery.");
      try {
        const windows = [];
        const owned = [...this.entries.values()].filter(entry => entry.owned);
        const nativeWindows = this.getMode() === "safe" && !owned.length ? [] : await this.list(signal);
        for (const native of nativeWindows) {
          if (query && !`${native.app_name} ${native.title}`.toLowerCase().includes(query.toLowerCase())) continue;
          const known = owned.find(entry => entry.target.pid === native.pid && entry.target.window_id === native.window_id);
          const entry = this.getMode() === "safe"
            ? known && await this.current(known.ref, signal)
            : await this.register(native as unknown as WindowTarget, signal);
          if (this.getMode() === "safe" && (!entry || !entry.owned)) continue;
          windows.push({ ...native, ...(entry ? { ...this.addressed(entry), owned: entry.owned } : { unavailable: "Cannot establish window lifetime identity." }) });
        }
        return this.result("listed", "Permitted window discovery. Safe lists session-opened windows only. Use window_ref, not PID/HWND.",
          { windows: this.getMode() === "safe" ? windows.filter(window => "owned" in window && window.owned) : windows });
      } catch (error) { return this.failed(error, false); }
    });
  }

  /** Discover installed app identifiers. Opening accepts an exact name or the returned app_id. */
  apps(signal?: AbortSignal, query?: string): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before app discovery.");
      try {
        const state = await this.state("list_apps", {}, signal);
        if (!Array.isArray(state.apps)) throw new Error("Driver returned no app list.");
        const apps = (state.apps as App[]).filter(app => app.launch_path && (!query || app.name.toLowerCase().includes(query.toLowerCase())))
          .map(app => ({ ...app, app_id: app.launch_path }));
        return this.result("listed", "Installed Windows apps. Open by exact name or app_id.", { apps });
      } catch (error) { return this.failed(error, false); }
    });
  }

  /** Launch once, establish a genuinely new window, and return its first UI observation. No shell strings from the model. */
  open(app: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before app opening.");
      let dispatched = false;
      try {
        const state = await this.state("list_apps", {}, signal);
        if (!Array.isArray(state.apps)) throw new Error("Driver returned no app list.");
        const matches = (state.apps as App[]).filter(item => item.launch_path &&
          (appName(item.name) === appName(app) || item.launch_path === app || item.bundle_id === app));
        const paths = [...new Map(matches.map(item => [item.launch_path, item])).values()];
        if (paths.length !== 1) return this.result("refused", paths.length
          ? "Ambiguous app name. Use computer_apps and an exact app_id."
          : "Installed app not found. Use computer_apps to find its exact name or app_id.");
        const selected = paths[0];
        const before = new Set<string>();
        for (const native of await this.list(signal)) before.add(`${native.pid}:${native.window_id}`);
        const aumid = selected.launch_path!.match(/^shell:appsFolder\\(.+!.+)$/i)?.[1];
        if (signal?.aborted) return this.result("refused", "Cancelled before launch dispatch.");
        dispatched = true;
        const launched = await this.state("launch_app", aumid ? { aumid } : { launch_path: selected.launch_path }, signal);
        const pid = launched.pid;
        if (!Number.isSafeInteger(pid) || (pid as number) <= 0) throw new Error("Launch returned no usable process ID; do not relaunch blindly.");
        let candidates: WindowEntry[] = [];
        for (let attempt = 0; attempt < 20; attempt++) {
          const nativeWindows = await this.list(signal);
          candidates = [];
          for (const native of nativeWindows) {
            // Packaged activation may return a broker PID while the new window belongs to an existing app process.
            const reported = Array.isArray(launched.windows) && launched.windows.some(window => {
              const item = window as WindowTarget;
              return item.pid === native.pid && item.window_id === native.window_id;
            });
            if (native.pid !== pid && appName(String(native.app_name ?? "")) !== appName(selected.name) && !reported) continue;
            // Treat baseline addresses as existing even if a handle is recycled during launch: fail closed.
            if (before.has(`${native.pid}:${native.window_id}`)) continue;
            const entry = await this.register(native as unknown as WindowTarget, signal);
            if (entry) candidates.push(entry);
          }
          if (candidates.length) break;
          if (attempt < 19) await delay(250, undefined, { signal });
        }
        if (candidates.length !== 1) return this.result("unknown", candidates.length
          ? "Launch produced multiple possible new windows. Discover them before choosing; ownership is not established."
          : "Launch did not establish a genuinely new window. It may have reused an existing window or opened a tab. Discover before deciding; do not relaunch blindly.");
        const entry = candidates[0];
        entry.owned = true;
        const observed = await this.capture(entry, signal);
        return this.result(observed.details.status, observed.details.status === "observed"
          ? "New application window opened. First observation is ready for one action."
          : "A new window appeared but its first observation failed. Discover before deciding.",
          observed.details.state, { ...observed.details, opened: true }, observed.content.filter(block => block.type === "image"));
      } catch (error) { return this.failed(error, dispatched); }
    });
  }

  /** Reproject proven window-local native geometry onto fresh CUA frames, never DPI guesses. */
  private actionMark(mark: GuideMark | undefined, mapping: DetailContext["windowMapping"]): GuideMark | undefined {
    if (!mark?.region) return mark;
    if (!mapping) return { reason: "Current native-to-image mapping is unavailable.", basis: mark.basis };
    const r = mark.region;
    return { basis: mark.basis, region: { x: (r.x - mapping.offsetX) / mapping.scale - 4,
      y: (r.y - mapping.offsetY) / mapping.scale - 4, width: r.width / mapping.scale + 8, height: r.height / mapping.scale + 8 } };
  }
  private imageMetadata(images: Content[], state: Record<string, unknown>, settings: CuaVisionSettings): Record<string, unknown> {
    const image = images.find(block => block.type === "image");
    if (!image || image.type !== "image") throw new Error("No native grounding image.");
    const bytes = Buffer.from(image.data, "base64");
    return { route: state.display === "primary" ? "cua_display" : "cua_window", configuration: settings,
      output: { width: state.screenshot_width, height: state.screenshot_height, bytes: bytes.length,
        mimeType: image.mimeType, hash: createHash("sha256").update(bytes).digest("hex") },
      coordinate_space: state.display === "primary" ? "display_image_pixels" : "window_image_pixels",
      native: { capture_id: state.capture_id, agent_overlay_capture: state.agent_overlay_capture } };
  }

  /** Capture one authorized source into a private bounded resource; no frame grants input or detail authority. */
  captureSequence(target: { window_ref?: string; display?: string }, options: SequenceOptions, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      try {
        validateSequence(options);
        if ((target.window_ref !== undefined) === (target.display !== undefined) || (target.display !== undefined && target.display !== "primary"))
          return this.result("refused", "Choose exactly one window_ref or display: primary.");
        const entry = target.window_ref ? this.entries.get(target.window_ref) : undefined;
        const permitted = () => entry ? this.allowed(entry) : target.display === "primary" && this.getMode() === "yolo";
        const denied = () => { this.sequences.clear(); return this.result("refused", "Sequence source access denied. Safe permits session-owned windows only; retained pixels withheld."); };
        if (!permitted()) return denied();
        const settings = { ...this.settings(), ...(options.maxLongEdge !== undefined ? { maxLongEdge: options.maxLongEdge } : {}),
          ...(options.scale !== undefined ? { scale: options.scale } : {}) };
        const cap = nativeImageCap(settings);
        if (entry) { entry.observation = undefined; entry.detail = undefined; }
        else this.displayOverview = undefined;
        let first = true;
        const sequence = await collectSequence(options, async active => {
          if (!permitted()) throw new SequenceStop("access_revoked");
          if (entry && !await this.current(entry.ref, active)) throw new SequenceStop("target_lost");
          if (!permitted()) throw new SequenceStop("access_revoked");
          const nativeStarted = performance.now();
          const native = await this.driver.call(entry ? "get_window_state" : "get_desktop_state", entry
            ? { ...entry.target, include_accessibility_tree: false, max_image_dimension: cap }
            : { max_image_dimension: cap }, active);
          const native_completed_at = performance.now();
          if (!permitted()) throw new SequenceStop("access_revoked");
          active.throwIfAborted();
          const state = native.structuredContent;
          if (native.isError || !state || state.status === "refused" || state.effect === "refused") throw new SequenceStop("capture_failed");
          if (!entry && (state.display !== "primary" || state.platform !== "windows")) throw new SequenceStop("capture_failed");
          if (entry && ((state.pid !== undefined && state.pid !== entry.target.pid) ||
            (state.window_id !== undefined && state.window_id !== entry.target.window_id))) throw new SequenceStop("target_lost");
          const images = native.content.filter((block): block is SequenceFrame["image"] => block.type === "image");
          const context = this.overview(state, "sequence-frame", !entry, images);
          if (!context || Math.max(context.width, context.height) > cap || images[0].data.length > 16 * 1024 * 1024)
            throw new SequenceStop("capture_failed");
          let source = observationSource(entry ? "window" : "display", state, entry
            ? { session_id: this.sessionId, window_ref: entry.ref, ...entry.target }
            : { session_id: this.sessionId, display_id: "primary" });
          source.semantic_scope = "none"; source.capabilities = { read: true, input: "none", detail: "unsupported" };
          let image = images[0];
          if (options.region) ({ image, source } = await cropSequenceFrame(image, source, options.region, first));
          first = false;
          if (entry && !await this.current(entry.ref, active)) throw new SequenceStop("target_lost");
          if (!permitted()) throw new SequenceStop("access_revoked");
          return { image, source, native_completed_at, native_latency_ms: native_completed_at - nativeStarted };
        }, signal);
        if (!permitted() || sequence.stop_reason === "access_revoked") return denied();
        sequence.configuration = settings;
        this.sequences.put(sequence);
        const metadata = sequenceMetadata(sequence);
        const complete = ["completed", "frame_limit"].includes(sequence.stop_reason);
        return this.result(complete ? "observed" : "refused", `Sequence ${sequence.stop_reason}: ${sequence.frames.length} frames, ${sequence.skipped_slots.length} skipped slots. No images forwarded; select frames explicitly. Read only; observe again before input.`,
          undefined, { sequence: metadata });
      } catch (error) {
        return this.result("refused", `Sequence did not start. ${error instanceof Error ? error.message : "Invalid capture request."}`);
      }
    });
  }

  /** Select retained pixels only after rechecking source identity and current access; no native recapture. */
  sequenceFrames(id: string, selection: FrameSelection, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const sequence = this.sequences.get(id);
      if (!sequence) return this.result("refused", "Sequence is unavailable or evicted. Capture again; resources do not survive reload/close.");
      const source = sequence.frames[0]?.source;
      const entry = source?.kind === "window" ? this.entries.get(String(source.identity.window_ref)) : undefined;
      const permitted = () => source?.kind === "window" ? !!entry && this.allowed(entry) : source?.kind === "display" && this.getMode() === "yolo";
      const denied = () => { this.sequences.clear(); return this.result("refused", "Retained sequence source is no longer accessible; pixels and metadata withheld."); };
      if (!permitted()) return denied();
      try {
        if (signal?.aborted) return this.result("refused", "Cancelled before frame selection.");
        if (entry && !await this.current(entry.ref, signal)) return denied();
        if (!permitted()) return denied();
        const frames = selectFrames(sequence, selection);
        const metadata = frames.map(({ image: _image, ...frame }) => frame);
        if (signal?.aborted) return this.result("refused", "Cancelled during frame selection; pixels withheld.");
        // Interleave frame labels with their images so both direct calls and Codemode preserve correspondence.
        const result = this.result("observed", `Selected ${frames.length} read-only sequence frames. Their indexes and measured timestamps label the image order.`, undefined,
          { selected_frames: metadata });
        for (const frame of frames) result.content.push({ type: "text", text: `Sequence ${id} · frame ${frame.index} · ${frame.timestamp_ms.toFixed(1)} ms` }, frame.image);
        return result;
      } catch {
        if (!permitted()) return denied();
        return this.result("refused", "Frame selection failed. Check captured-frame indexes and the source's current lifetime.");
      }
    });
  }
  /** Read the primary display in YOLO only. This source never grants or grounds desktop input. */
  observeDisplay(display: string, signal?: AbortSignal, zoom?: DetailRequest): Promise<ComputerResult> {
    return this.queue(async () => {
      const denied = () => {
        this.displayOverview = undefined;
        return this.result("refused", "Safe mode forbids full-display reading. Only the user can select YOLO with /computer-mode.");
      };
      if (this.getMode() !== "yolo") return denied();
      if (signal?.aborted) return this.result("refused", "Cancelled before display capture.");
      if (display !== "primary") return this.result("refused", "Only the native primary display is supported.");
      if (zoom) return this.displayDetail(zoom, signal);
      this.displayOverview = undefined;
      try {
        const settings = { ...this.settings() }; const cap = nativeImageCap(settings);
        const native = await this.driver.call("get_desktop_state", { max_image_dimension: cap }, signal);
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) return this.result("refused", "Cancelled during display capture; pixels withheld.");
        const state = native.structuredContent;
        if (native.isError || state?.status === "refused" || state?.effect === "refused")
          return this.result("refused", "CUA refused primary-display capture.");
        const images = native.content.filter(block => block.type === "image" && block.mimeType === "image/png");
        if (!state || state.display !== "primary" || state.platform !== "windows" || images.length !== 1 ||
          !Number.isSafeInteger(state.screenshot_width) || !Number.isSafeInteger(state.screenshot_height) ||
          (state.screenshot_width as number) <= 0 || (state.screenshot_height as number) <= 0 ||
          Math.max(state.screenshot_width as number, state.screenshot_height as number) > cap)
          throw new Error("CUA returned no valid scoped primary-display image.");
        const source = observationSource("display", state, { session_id: this.sessionId, display_id: "primary" });
        const id = randomUUID(); this.displayOverview = this.overview(state, id, true, images);
        const context = this.displayOverview;
        const highlight = await notifyHighlight(this.observer, context ? { display: "primary", bounds: { x: 0, y: 0, width: context.originalWidth, height: context.originalHeight } } : undefined, signal);
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) { this.displayOverview = undefined; return this.result("refused", "Cancelled during display frame; pixels withheld."); }
        return this.result("observed", "Native primary-display overview. Read only; zoom uses image_id and these pixels. Paint freshness is unverified.",
          state, { source, ...(highlight ? { highlight } : {}), agent_image: { ...this.imageMetadata(images, state, settings), image_id: id } }, images);
      } catch (error) {
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) return this.result("refused", "Cancelled during display capture; diagnostics withheld.");
        return this.failed(error, false);
      }
    });
  }

  private async displayDetail(request: DetailRequest, signal?: AbortSignal): Promise<ComputerResult> {
    const overview = this.displayOverview;
    let cap: number;
    try { cap = validateDetail(request, overview, false); }
    catch (error) { return this.result("refused", (error as Error).message); }
    this.displayOverview = undefined;
    try {
      if (this.getMode() !== "yolo" || signal?.aborted) return this.result("refused", "Display detail permission or request cancelled.");
      const native = await this.driver.call("get_desktop_state", { max_image_dimension: 0 }, signal);
      if (this.getMode() !== "yolo" || signal?.aborted) return this.result("refused", "Display detail revoked or cancelled; pixels withheld.");
      const state = native.structuredContent;
      const images = native.content.filter((block): block is Extract<Content, { type: "image" }> => block.type === "image");
      if (native.isError || state?.status === "refused" || state?.effect === "refused" || !state || state.display !== "primary" || state.platform !== "windows" ||
        images.length !== 1 || state.screenshot_width !== overview!.originalWidth || state.screenshot_height !== overview!.originalHeight ||
        this.geometry(state, true) !== overview!.geometry)
        return this.result("refused", "Fresh display geometry or capture is incompatible. Take a new overview.");
      const capturedAt = new Date().toISOString();
      const region = nativeRegion(request, overview!);
      const detail = await cropDisplay(images[0], overview!, region, cap);
      if (this.getMode() !== "yolo" || signal?.aborted) return this.result("refused", "Display detail revoked or cancelled during processing; pixels withheld.");
      const output = { screenshot_width: detail.width, screenshot_height: detail.height, display: "primary" };
      const source = observationSource("display", output, { session_id: this.sessionId, display_id: "primary" });
      source.captured_at = capturedAt;
      source.image.scope = "primary_display_region"; source.image.coordinate_space = "detail_image_pixels"; source.capabilities.detail = "unsupported";
      source.image.original_dimensions = { width: overview!.originalWidth, height: overview!.originalHeight };
      source.image.origin = { x: region.left, y: region.top, relative_to: "primary_display" };
      const configuration = { maxLongEdge: request.maxLongEdge ?? 1200, scale: request.scale ?? 1, kernel: "lanczos3" as const, version: 0, route: "cua_native" as const };
      const agent_image = { ...this.imageMetadata([detail.image], output, configuration), route: "cua_fresh_display_crop",
        coordinate_space: "detail_image_pixels", configuration: { ...configuration, route: "adapter_crop_resize" },
        region: { overview: { image_id: overview!.id, dimensions: { width: overview!.width, height: overview!.height }, x: request.x, y: request.y, width: request.width, height: request.height }, native: region },
        native: { resolution: "full", intermediate_pixels: "withheld" }, input: "none" };
      const highlight = await notifyHighlight(this.observer, { display: "primary",
        bounds: { x: 0, y: 0, width: overview!.originalWidth, height: overview!.originalHeight },
        mark: { kind: "detail", region: { x: region.left, y: region.top, width: region.width, height: region.height } } }, signal);
      if (this.getMode() !== "yolo" || signal?.aborted) return this.result("refused", "Display detail revoked or cancelled during frame; pixels withheld.");
      return this.result("observed", "Fresh native display pixels cropped above CUA. Read only; no nested crop or input. Paint freshness is unverified.",
        undefined, { source, agent_image, ...(highlight ? { highlight } : {}) }, [detail.image]);
    } catch { return this.result("refused", "Display detail failed; private intermediate pixels and diagnostics withheld. Take a new overview."); }
  }

  private async windowDetail(entry: WindowEntry, request: DetailRequest, signal?: AbortSignal): Promise<ComputerResult> {
    const overview = entry.detail;
    try { validateDetail(request, overview, true); }
    catch (error) { return this.result("refused", (error as Error).message); }
    entry.detail = undefined; entry.observation = undefined;
    try {
      if (!this.allowed(entry) || signal?.aborted || !await this.current(entry.ref, signal) || !this.allowed(entry) || signal?.aborted)
        return this.result("refused", "Window closed, detail revoked or cancelled. Observe again.");
      const native = await this.driver.call("zoom", { ...entry.target, x1: request.x, y1: request.y, x2: request.x + request.width, y2: request.y + request.height }, signal);
      if (!this.allowed(entry) || signal?.aborted || !await this.current(entry.ref, signal) || !this.allowed(entry) || signal?.aborted)
        return this.result("refused", "Window closed, detail revoked or cancelled; pixels withheld.");
      const state = native.structuredContent;
      const images = native.content.filter(block => block.type === "image" && block.mimeType === "image/jpeg");
      if (native.isError || state?.status === "refused" || state?.effect === "refused" || !state || images.length !== 1 ||
        !Number.isSafeInteger(state.width) || !Number.isSafeInteger(state.height) || (state.width as number) <= 0 || (state.width as number) > 500 || (state.height as number) <= 0)
        return this.result("refused", "CUA refused or returned invalid window zoom.");
      const source = observationSource("window", state, { session_id: this.sessionId, window_ref: entry.ref, ...entry.target }, true);
      source.capabilities.input = "none"; source.semantic_scope = "none";
      const image = images[0] as Extract<Content, { type: "image" }>; const bytes = Buffer.from(image.data, "base64");
      const windows = await this.list(signal);
      if (!this.allowed(entry) || signal?.aborted) return this.result("refused", "Window detail revoked or cancelled; pixels withheld.");
      const window = windows.find(w => w.pid === entry.target.pid && w.window_id === entry.target.window_id);
      if (!window) return this.result("refused", "Window closed during detail; pixels withheld.");
      const bounds = screenRect(window.bounds);
      const highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, bounds, signal,
        { kind: "detail", region: bounds ? windowRegion(request, overview!.windowMapping, bounds) : undefined });
      if (!this.allowed(entry) || signal?.aborted) return this.result("refused", "Window detail revoked or cancelled during frame; pixels withheld.");
      return this.result("observed", "Fresh native window zoom. CUA owns JPEG padding and geometry. Read only; take a new overview before input or another detail.",
        undefined, { ...this.addressed(entry), ...(highlight ? { highlight } : {}), source, agent_image: { route: "cua_fresh_window_zoom", coordinate_space: "zoom_image_pixels",
          configuration: { padding: "20% each side", maxWidth: 500, route: "cua_native" }, native: state,
          region: { overview: { image_id: overview!.id, dimensions: { width: overview!.width, height: overview!.height }, x: request.x, y: request.y, width: request.width, height: request.height } },
          output: { width: state.width, height: state.height, bytes: bytes.length, mimeType: image.mimeType, hash: createHash("sha256").update(bytes).digest("hex") }, input: "none" } }, images);
    } catch { return this.result("refused", "Window detail failed; pixels and diagnostics withheld. Observe again."); }
  }
  private async capture(entry: WindowEntry, signal?: AbortSignal, query?: string, options: UiCaptureOptions = {}): Promise<ComputerResult> {
    validateUiCapture(options);
    if (!this.allowed(entry)) return this.denied(entry.ref);
    entry.observation = undefined; entry.detail = undefined;
    const current = await this.current(entry.ref, signal);
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (!current) return this.result("refused", "Window closed or its native handle was reused. Discover again.");
    const settings = structuredClone({ ...this.settings(), ...(options.hints !== undefined ? { hints: options.hints } : {}), ...(options.guides ? { guides: options.guides } : {}) });
    const native = await this.driver.call("get_window_state", {
      ...entry.target, max_elements: options.max_elements ?? 200, max_depth: options.max_depth ?? 15, timeout_ms: 5000,
      max_image_dimension: nativeImageCap(settings), ...(query ? { query } : {}),
    }, signal);
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (signal?.aborted) return this.result("refused", "Cancelled during observation; pixels withheld.");
    if (native.isError) return this.result("refused", "Driver refused observation.", native.structuredContent, this.addressed(entry));
    const state = native.structuredContent;
    if (!state || !Array.isArray(state.elements)) throw new Error("Driver returned no structured UI elements.");
    const images = native.content.filter(block => block.type === "image");
    if (!images.length) throw new Error("Driver returned no grounding screenshot.");
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (!await this.current(entry.ref, signal)) return this.result("refused", "Window changed during observation. Discover again.");
    if (!this.allowed(entry)) return this.denied(entry.ref);
    // Detail always uses fresh CUA pixels; returned PNG retention is only for snapshot annotation.
    const id = randomUUID();
    entry.detail = this.overview(state, id, false, images);
    const ui = createUiResource(state, entry.ref, id, ++this.uiSerial);
    entry.observation = { id, ui, settings, width: typeof state.screenshot_width === "number" ? state.screenshot_width : undefined,
      height: typeof state.screenshot_height === "number" ? state.screenshot_height : undefined,
      tokens: new Set(state.elements.map(element => (element as { element_token?: unknown }).element_token)
        .filter((token): token is string => typeof token === "string")),
      captureId: typeof state.capture_id === "string" ? state.capture_id : undefined,
      bounds: screenRect(state.window_bounds),
      frames: new Map(state.elements.flatMap(element => {
        const e = element as { element_token?: string; frame?: unknown };
        const bounds = screenRect(state.window_bounds); const region = bounds && elementRegion(e.frame, bounds);
        return e.element_token && region ? [[e.element_token, region] as [string, ScreenRect]] : [];
      })) };
    if (signal?.aborted) { entry.observation = undefined; entry.detail = undefined; return this.result("refused", "Cancelled during observation; pixels withheld."); }
    const source = observationSource("window", state, { session_id: this.sessionId, window_ref: entry.ref, ...entry.target });
    const highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, state.window_bounds, signal);
    if (!this.allowed(entry)) { entry.observation = undefined; entry.detail = undefined; return this.denied(entry.ref); }
    if (signal?.aborted) { entry.observation = undefined; entry.detail = undefined; return this.result("refused", "Cancelled during window frame; pixels withheld."); }
    const observed = entry.observation!;
    observed.source = source;
    const raw = images[0];
    // Keep at most three recent returned PNGs for local annotation, never a saved-original crop backend.
    if (raw?.type === "image" && Buffer.byteLength(raw.data, "base64") <= 12 * 1024 * 1024) {
      observed.rawImage = raw;
      const active = new Set([...this.entries.values()].map(e => e.observation));
      this.uiImages = [...this.uiImages.filter(old => active.has(old)), observed];
      for (const old of this.uiImages.splice(0, Math.max(0, this.uiImages.length - 3))) old.rawImage = undefined;
    }
    observed.mapping = entry.detail?.windowMapping;
    observed.actionMark = this.actionMark(entry.lastAction, observed.mapping);
    const rendered = await annotateUi(raw, ui, observed.width, observed.height, options.hints ?? settings.hints ?? true, undefined, ui.elements,
      { options: settings.guides, action: observed.actionMark });
    if (!this.allowed(entry) || signal?.aborted) { entry.observation = undefined; entry.detail = undefined; return this.result("refused", "Observation revoked or cancelled during annotation; pixels withheld."); }
    if (rendered.image !== raw) this.retainRaw?.(raw);
    const metadata = this.imageMetadata([rendered.image], state, settings);
    return this.result("observed", `Fresh native window observation: ${ui.elements.length} UI elements; ${rendered.annotation.labels.length} image hints. Structure ${ui.complete === true ? "complete" : ui.complete === false ? "partial" : "completeness unknown"}; paint freshness is unverified. Hints belong to this observation only.`,
      state, { ...this.addressed(entry), ...(highlight ? { highlight } : {}), observation_id: id, source, ui: structuredClone(ui),
        agent_image: { ...metadata, ...(rendered.image !== raw ? { route: "cua_native_ui_hints" } : {}), annotation: rendered.annotation, image_id: id } }, [rendered.image]);
  }

  /** Read fresh UI state and a screenshot for an existing session reference. Only this window's earlier observation expires. */
  observe(ref: string, signal?: AbortSignal, query?: string, zoom?: DetailRequest, ui?: UiRequest, options?: UiCaptureOptions): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before observation.");
      try {
        const known = this.entries.get(ref);
        if (known && !this.allowed(known)) return this.denied(ref);
        const entry = await this.current(ref, signal);
        if (known && !this.allowed(known)) return this.denied(ref);
        if ((ui && (zoom || query !== undefined || options)) || (zoom && (query !== undefined || options))) return this.result("refused", "Choose native overview, zoom, or a local UI operation; do not combine them.");
        if (options) {
          try { validateUiCapture(options); }
          catch (error) { return this.result("refused", (error as Error).message); }
        }
        if (zoom && !known?.detail) return this.result("refused", "Detail needs a current overview. Observe again.");
        return entry ? ui ? await this.refineUi(entry, ui, signal) : zoom ? await this.windowDetail(entry, zoom, signal) : await this.capture(entry, signal, query, options) : this.result("refused", "Unknown or closed window_ref. Discover again.");
      } catch (error) { return this.failed(error, false); }
    });
  }

  private async refineUi(entry: WindowEntry, request: UiRequest, signal?: AbortSignal): Promise<ComputerResult> {
    const observed = entry.observation;
    if (!observed || observed.id !== request.observation_id) return this.result("refused", "Retired UI observation. Observe again.");
    let ui: UiResource;
    try { ui = projectUi(observed.ui, request); }
    catch (error) { return this.result("refused", (error as Error).message); }
    if (request.operation === "crop") {
      const selected = ui.elements[0];
      const region = selected?.bounds.window_image;
      if (!region || !observed.width || !observed.height) return this.result("refused", "Element has no proven screenshot-local bounds.");
      const clipped = { x: Math.max(0, region.x), y: Math.max(0, region.y),
        width: Math.min(observed.width, region.x + region.width) - Math.max(0, region.x),
        height: Math.min(observed.height, region.y + region.height) - Math.max(0, region.y) };
      if (clipped.width <= 0 || clipped.height <= 0) return this.result("refused", "Element is outside the observed image.");
      return this.windowDetail(entry, { image_id: observed.id, ...clipped }, signal);
    }
    if (request.operation === "region") {
      const r = request.region!;
      if (!observed.width || !observed.height || r.x + r.width > observed.width || r.y + r.height > observed.height)
        return this.result("refused", "Region must fit within the current overview image.");
      observed.region = { ...r };
    }
    if (["highlight", "scope", "region"].includes(request.operation)) {
      if (!observed.rawImage) return this.result("refused", "Snapshot image was evicted. Read a new overview; its hints will change.");
      const rendered = await annotateUi(observed.rawImage, ui, observed.width, observed.height,
        observed.settings.hints ?? true, request.operation === "highlight" ? request.hint : undefined, observed.ui.elements,
        { options: observed.settings.guides, region: observed.region, action: observed.actionMark });
      if (!this.allowed(entry) || signal?.aborted) return this.result("refused", "UI inspection revoked or cancelled; pixels withheld.");
      if (rendered.image !== observed.rawImage) this.retainRaw?.(observed.rawImage);
      const metadata = this.imageMetadata([rendered.image], { screenshot_width: observed.width, screenshot_height: observed.height }, observed.settings);
      return this.result("observed", `Read-only ${request.operation} of the existing UI snapshot: ${ui.elements.length}/${ui.matches} elements. No native reread or input; pixels are from the original observation.`,
        undefined, { ...this.addressed(entry), observation_id: observed.id, ui, source: observed.source,
          agent_image: { ...metadata, route: "cua_snapshot_ui_hints", annotation: rendered.annotation, image_id: observed.id } }, [rendered.image]);
    }
    return this.result("observed", `Read-only UI ${request.operation}: ${ui.elements.length}/${ui.matches} matches in the collected snapshot. ${ui.complete === true ? "Native collection reported complete." : "Collection may be partial; absence does not prove nonexistence."}`,
      undefined, { ...this.addressed(entry), observation_id: observed.id, ui });
  }
  /** Consume one overview for a complete action or bounded sequence. Never replay a completed prefix. */
  act(action: Action, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before action dispatch.");
      const entry = this.entries.get(action.window_ref);
      if (entry && !this.allowed(entry)) return this.denied(entry.ref);
      const observed = entry?.observation;
      if (!entry || !observed || action.observation_id !== observed.id)
        return this.result("refused", "Stale or missing observation_id/window_ref. Observe again.");
      const { window_ref: _ref, observation_id: _id, delivery_mode, ...command } = action;
      const batch = command.action === "sequence";
      let commands: InputStep[];
      try {
        if (delivery_mode !== undefined && !["background", "foreground"].includes(delivery_mode)) throw new Error("Unsupported delivery mode.");
        if (batch) {
          if (Object.keys(command).some(key => !["action", "sequence"].includes(key)) || !Array.isArray(command.sequence) || command.sequence.length < 1 || command.sequence.length > 32)
            throw new Error("A sequence needs 1..32 steps and no conflicting top-level action fields.");
          commands = command.sequence;
        } else commands = [command];
        commands = commands.map(step => {
          const { hint, ...nativeStep } = step;
          if (hint !== undefined) {
            if (typeof hint !== "string" || step.element_token !== undefined || step.x !== undefined || step.y !== undefined)
              throw Error("Use exactly one current hint or native token/pixel target.");
            nativeStep.element_token = resolveUi(observed.ui, hint).element_token;
          }
          const element = observed.ui.elements.find(e => e.element_token === nativeStep.element_token);
          if (element?.enabled === false) throw Error("The observed target is disabled. No input was dispatched.");
          if (element?.bounds.window_image && observed.width && observed.height) {
            const r = element.bounds.window_image;
            if (r.x >= observed.width || r.y >= observed.height || r.x + r.width <= 0 || r.y + r.height <= 0)
              throw Error("The observed target is outside the image. No input was dispatched.");
          }
          validateInput(nativeStep, observed, batch);
          return nativeStep;
        });
        if (commands.some(step => step.action === "hold") && !this.driver.heldKeys)
          throw new Error("Key holds require the explicitly selected qualified Windows key-hold runtime. No input was dispatched.");
        if (commands.some(step => step.via !== undefined) && !this.driver.heldPaths)
          throw new Error("Continuous paths require the explicitly selected qualified Windows fork. No batch input was dispatched.");
        if (batch && commands.reduce((ms, step) => ms + requestedInputTime(step), 0) > 30000)
          throw new Error("A sequence exceeds 30 seconds of requested waits/typing/drags.");
        commands = commands.map(step => ({ ...step, ...(step.keys ? { keys: [...step.keys] } : {}), ...(step.modifiers ? { modifiers: [...step.modifiers] } : {}), ...(step.via ? { via: step.via.map(point => ({ ...point })) } : {}), ...(step.actions ? { actions: step.actions.map(pointer => ({ ...pointer, ...(pointer.via ? { via: pointer.via.map(point => ({ ...point })) } : {}) })) } : {}) }));
      } catch (error) { return this.result("refused", (error as Error).message); }

      const started = performance.now();
      const trace = { total: commands.length, attempted: 0, completed: 0, elapsed_ms: 0,
        steps: [] as Record<string, unknown>[], stop_reason: "" };
      let inFlight = false;
      const finish = (result: ComputerResult, reason = "") => {
        if (!batch) return result;
        trace.elapsed_ms = performance.now() - started; trace.stop_reason = reason;
        const status = result.details.status;
        return this.result(status, `Sequence ${status}: ${trace.completed}/${trace.total} steps delivered; ${trace.attempted} attempted in ${Math.round(trace.elapsed_ms)}ms. ${reason || "Observe again to verify application state."} Never replay the completed prefix.`,
          { ...(result.details.state ?? {}), sequence: trace }, { ...this.addressed(entry), ...(result.details.highlight ? { highlight: result.details.highlight } : {}) });
      };
      try {
        for (const [index, step] of commands.entries()) {
          if (signal?.aborted) return finish(this.result("refused", "Cancelled."), "Cancelled before the next dispatch.");
          if (!this.allowed(entry)) return finish(this.denied(entry.ref), "Permission revoked before the next dispatch.");
          if (batch && performance.now() - started >= 45000) return finish(this.result("refused", "Sequence time budget reached."), "45s elapsed budget reached; no more steps dispatched.");
          if (step.wait_ms) await delay(step.wait_ms, undefined, { signal });
          const current = await this.current(entry.ref, signal);
          if (!this.allowed(entry)) return finish(this.denied(entry.ref), "Permission revoked before dispatch.");
          if (!current) return finish(this.result("refused", "Window closed or its native handle was reused. Discover again."), "Window lifetime changed.");
          if (signal?.aborted) return finish(this.result("refused", "Cancelled."), "Cancelled before dispatch.");
          const { name, args } = nativeInput(step, entry.target, delivery_mode ?? "background", observed.captureId);
          // AX bounds are native. Only native click receipts establish an exact pixel action mark.
          const mark = { kind: "action" as const, region: step.element_token ? observed.frames.get(step.element_token) : undefined };
          let highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, observed.bounds, signal, mark);
          if (signal?.aborted) return finish(this.result("refused", "Cancelled during action mark; input was not dispatched."), "Cancelled during action mark.");
          if (!this.allowed(entry)) return finish(this.denied(entry.ref), "Permission revoked during action mark.");
          if (batch && performance.now() - started >= 45000) return finish(this.result("refused", "Sequence time budget reached."), "45s elapsed budget reached during admission; no more steps dispatched.");
          entry.observation = undefined; entry.detail = undefined;
          const pointerAction = ["click", "right_click", "double_click", "drag"].includes(step.action) || (step.action === "hold" && !!step.actions?.length);
          if (pointerAction) entry.lastAction = { reason: "Pointer outcome is not yet confirmed." };
          const requested = { ...step, ...(step.text !== undefined ? { text_length: step.text.length } : {}),
            ...(step.via ? { via_points: step.via.length } : {}), ...(step.actions ? { actions: step.actions.map(pointer => { const { via, ...compact } = pointer; return { ...compact, ...(via ? { via_points: via.length } : {}) }; }) } : {}) };
          delete requested.text; delete requested.element_token;
          delete requested.via;
          const row: Record<string, unknown> = { index, action: step.action, native_tool: name, requested,
            requested_wait_ms: step.wait_ms ?? 0, dispatch_ms: performance.now() - started, status: "unknown" };
          trace.steps.push(row); trace.attempted++; inFlight = true;
          const native = await this.driver.call(name, args, signal);
          row.completion_ms = performance.now() - started;
          if (!this.allowed(entry) || signal?.aborted) return finish(this.result("unknown",
            "Input was dispatched before permission was revoked or cancellation. Outcome withheld; native input may still have completed. Do not replay blindly."),
            "In-flight outcome withheld after revocation/cancellation.");
          const state = native.structuredContent ?? {};
          const refused = state.status === "refused" || state.effect === "refused" || ["invalid_action_target", "invalid_arguments", "stale_element_token",
            "conflicting_element_target", "background_unavailable", "background_occluded", "background_uipi_blocked", "key_hold_unavailable", "held_path_unavailable"].includes(String(state.code));
          const uncertain = native.isError || ["unknown", "partial"].includes(String(state.status)) || ["unknown", "partial"].includes(String(state.effect));
          const status = refused ? "refused" : uncertain ? "unknown" : "delivered";
          row.status = status; inFlight = false;
          const capability = actionCapability(step.action, name, delivery_mode ?? "background", status, state);
          row.action_capability = capability;
          if (status === "delivered") trace.completed++;
          const resolvedPoint = status === "delivered" && step.x !== undefined && step.action === "click" && observed.bounds
            ? nativeClickPoint(native.content, entry.target.pid, observed.bounds) : undefined;
          if (status === "delivered" && pointerAction) {
            const target = step.element_token ? observed.frames.get(step.element_token) : undefined;
            const mapping = observed.mapping;
            const sameMapping = resolvedPoint && observed.bounds && mapping && step.x !== undefined && step.y !== undefined &&
              Math.abs(resolvedPoint.x - (observed.bounds.x + mapping.offsetX + step.x * mapping.scale)) <= 1 &&
              Math.abs(resolvedPoint.y - (observed.bounds.y + mapping.offsetY + step.y * mapping.scale)) <= 1;
            const r = target ?? (sameMapping ? { ...resolvedPoint, width: 1, height: 1 } : undefined);
            entry.lastAction = r && observed.bounds
              ? { region: { ...r, x: r.x - observed.bounds.x, y: r.y - observed.bounds.y },
                basis: target ? "completed_native_token_target" : "completed_native_click_receipt" }
              : { reason: "Native action did not report usable target geometry." };
          }
          if (status === "delivered" && step.x !== undefined && step.action === "click" && observed.bounds) {
            const point = resolvedPoint;
            highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, observed.bounds, signal, { kind: "action", point });
          }
          if (!this.allowed(entry) || signal?.aborted) {
            entry.lastAction = { reason: "In-flight pointer outcome was withheld after revocation or cancellation." };
            return finish(this.result("unknown", "Input was dispatched before revocation or cancellation. Do not replay blindly."), "In-flight outcome withheld after input.");
          }
          const result = this.result(status, `Driver returned ${status} for ${name} (requested: ${args.delivery_mode}). Observe again to verify application state.${step.action === "hold" && typeof state.summary === "string" ? `\n${state.summary}` : ""}`,
            { ...state, ...(step.element_token || pointerAction ? { coordinate_grounding: { input_space: step.element_token ? "native_element_token" : "window_image_pixels", transform: "cua_native_once",
              overview: { width: observed.width, height: observed.height }, ...(step.x !== undefined ? { requested: { x: step.x, y: step.y } } : {}),
              resolved_native_screen: resolvedPoint ?? null, native_target_mark: entry.lastAction ?? null } } : {}),
            ...(native.isError || !native.structuredContent ? {
              native_message: native.content.filter(c => c.type === "text").map(c => c.text).join("\n"),
            } : {}) }, { ...this.addressed(entry), action_capability: capability, ...(highlight ? { highlight } : {}) });
          if (!batch || status !== "delivered" || index === commands.length - 1)
            return finish(result, status === "delivered" ? "" : `Stopped after native ${status}; later steps were not dispatched.`);
        }
        throw new Error("No complete input step.");
      } catch (error) {
        if (inFlight && trace.steps.length) trace.steps.at(-1)!.completion_ms = performance.now() - started;
        return finish(await this.failed(error, inFlight), inFlight ? "Transport/dispatch failed; current step is uncertain." : "Stopped before next dispatch.");
      }
    });
  }

  /** Release owned runtime and invalidate references. Application windows and files are not closed or saved. */
  close(): Promise<ComputerResult> {
    return this.queue(async () => {
      this.entries.clear(); this.displayOverview = undefined; this.uiImages = []; this.sequences.clear();
      await this.driver.close();
      return this.result("closed", "Owned computer-use runtime closed. Application windows were not closed.");
    });
  }
}
