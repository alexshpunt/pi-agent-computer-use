import { randomUUID, createHash } from "node:crypto";
import { nativeDisplay, selectedDisplaySource, type NativeDisplay } from "./selected-displays.ts";
import { collectSequence, cropSequenceFrame, frameSummary, selectFrames, sequenceMetadata, SequenceStop, SequenceStore, validateSequence, type SequenceOptions, type FrameSelection, type SequenceFrame } from "./temporal-capture.ts";
import type { GuideMark } from "./image-guides.ts";
import { createUiResource, projectUi, resolveUi, annotateUi, validateUiCapture, type UiResource, type UiRequest, type UiCaptureOptions } from "./ui-resources.ts";
import { isSemanticAction, semanticReceipt } from "./semantic-actions.ts";
import { isPointerMove, pointerReceipt } from "./pointer-actions.ts";
import { isCoordinateScroll, scrollReceipt } from "./scroll-actions.ts";
import { validWindowStatus, windowRestoreStatus } from "./window-restore.ts";
import { validWindowControlState, windowManagementStatus, type WindowManagementCommand } from "./window-management.ts";
import { nativeInput, requestedInputTime, validateInput, type InputCommand, type InputStep } from "./complete-input.ts";
import { notifyWindowObserver, notifyHighlight, type WindowObserver, type HighlightResult } from "./window-overlay.ts";
import { screenRect, elementRegion, windowImageMapping, windowRegion, nativeClickPoint, type ScreenRect } from "./highlight-geometry.ts";
import { observationSource, sourceIdentity, type ObservationSource, type SourceIdentity, type NativePlatform } from "./observation-source.ts";
import { actionCapability, type ActionCapability } from "./action-capability.ts";
import { nativeImageCap, type CuaVisionSettings } from "./cua-image-settings.ts";
import { setTimeout as delay } from "node:timers/promises";
import { cropDisplay, nativeRegion, validateDetail, type DetailContext, type DetailRequest } from "./native-detail.ts";
import { WebError, type WebAction, type WebBrowser, type WebLauncher, type WebLaunchOptions, type WebPage, type WebSnapshotOptions, type WebTarget } from "./web-browser.ts";

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
  /** Native execution platform. Omitted by older in-process fixtures, which model Windows. */
  platform?: NativePlatform;
  /** False where native lifetime binding is not implemented; never substitute reusable IDs. */
  windowLifetime?: boolean;
  /** True only for a backend qualified for held paths and graceful in-flight release. */
  heldPaths?: boolean;
  /** True only for a qualified native runtime with bounded keyboard ownership. */
  heldKeys?: boolean;
  /** True only for a qualified Windows runtime with exact selected-display read contracts. */
  selectedDisplays?: boolean;
  /** True only for a qualified native runtime that admits both straight-drag endpoints against one capture. */
  captureBoundDrag?: boolean;
  /** True when existing native cursor controls can be scoped and restored for one action. */
  reactiveAnimation?: boolean;
  /** True only for an exact qualified Windows runtime with UIA-only semantic dispatch. */
  semanticActions?: boolean;
  /** True only for the explicitly selected, byte-checked Windows native pointer runtime. */
  nativePointer?: boolean;
  /** True only for an explicitly selected, byte-checked Windows capture-bound wheel runtime. */
  coordinateScroll?: boolean;
  /** True only for a byte-qualified Windows state admission and no-input restore runtime. */
  windowRestore?: boolean;
  /** True only for an exact byte-qualified Windows state-bound management runtime. */
  windowManagement?: boolean;
  /** True only for an exact qualified runtime whose window image/full reads default to session-owned WGC. */
  persistentWgc?: boolean;
  /** Fixed overview filter of the selected native runtime; never a tool-controlled resize switch. */
  overviewKernel?: CuaVisionSettings["kernel"];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal, options?: { animation?: "reactive" }): Promise<DriverResult>;
  identity(target: WindowTarget, create: boolean, signal?: AbortSignal): Promise<string | undefined>;
  close(): Promise<void>;
}
/** One complete action or bounded known-target sequence, grounded in one window overview. */
export type Action = {
  window_ref: string;
  observation_id: string;
  delivery_mode?: "background" | "foreground";
  /** Explicit opt-in to the trusted local reactive cursor-animation timing. */
  animation?: "reactive";
} & (InputCommand | { action: "sequence"; sequence: InputStep[] });
/** A stored Playwright snapshot of the active tab, with the tab list, any held dialog and events since the previous snapshot. */
export interface WebDom extends WebPage { truncated: boolean; matches?: number }
/** Delivery is not a task postcondition. Unknown input is never automatically replayed. */
export interface ComputerResult {
  content: Content[];
  details: {
    status: "listed" | "observed" | "delivered" | "refused" | "unknown" | "closed";
    mode: ComputerMode;
    target?: WindowTarget;
    window_ref?: string;
    observation_id?: string;
    /** One-use window-state authority for native restore or management, never ordinary input. */
    window_state_id?: string;
    /** Management state also admits restore; restore-only state cannot manage windows. */
    window_state_kind?: "restore" | "management";
    opened?: boolean;
    state?: Record<string, unknown>;
    source?: ObservationSource;
    source_identity?: SourceIdentity;
    action_capability?: ActionCapability;
    agent_image?: Record<string, unknown>;
    highlight?: HighlightResult;
    ui?: UiResource;
    /** Fresh Playwright page structure for an owned browser window. */
    dom?: WebDom;
    /** Fresh window capture parts; omitted for non-overview results. */
    granularity?: "image" | "ui" | "full";
    captured?: { image: boolean; ui: boolean };
    sequence?: ReturnType<typeof sequenceMetadata>;
    selected_frames?: Omit<SequenceFrame, "image">[];
  };
  isError?: boolean;
}
interface Observation { id: string; backend?: "wgc"; tokens: Set<string>; width?: number; height?: number; captureId?: string; bounds?: ScreenRect; frames: Map<string, ScreenRect>; ui?: UiResource; rawImage?: Content; source?: ObservationSource; settings: CuaVisionSettings; region?: ScreenRect; actionMark?: GuideMark; mapping?: DetailContext["windowMapping"] }
interface WindowState { id: string; nativeId: string; kind: "restore" | "management" }
interface WindowEntry { ref: string; target: WindowTarget; identity: string; owned: boolean; observation?: Observation; windowState?: WindowState; dom?: { id: string; page: WebDom }; web?: WebBrowser; detail?: DetailContext; lastAction?: GuideMark }
interface App { name: string; launch_path?: string; bundle_id?: string; kind?: string }
interface DisplayEntry { ref: string; topology: string; native: NativeDisplay; detail?: DetailContext }
/** Aria snapshots above this many characters are cut; narrow them with a target or depth. */
const WEB_SNAPSHOT_LIMIT = 80_000;
const appName = (name: string) => name.trim().toLowerCase().replace(/^windows\s+/, "").replace(/\.exe$/, "");

/** Multi-window UI policy. Native work is queued; ownership and observations are not persisted across reloads. */
export class ComputerSession {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, WindowEntry>();

  private readonly sessionId = randomUUID();
  private displayOverview?: DetailContext;
  private readonly displayEntries = new Map<string, DisplayEntry>();
  private readonly sequences = new SequenceStore();
  private uiSerial = 0;
  private uiImages: Observation[] = [];
  /**
   * Playwright browsers opened by this session, keyed by `pid:window_id` of the window bound at launch.
   * Popup windows of the same process are ordinary native windows; their pages are reached as tabs of this browser.
   */
  private readonly browsers = new Map<string, WebBrowser>();

  private get platform(): NativePlatform { return this.driver.platform ?? "windows"; }

  private source(kind: ObservationSource["kind"], native: Record<string, unknown>, identity: ObservationSource["identity"], zoom = false): ObservationSource {
    return observationSource(kind, native, identity, zoom, this.platform);
  }
  private geometry(state: Record<string, unknown>, display: boolean): string {
    if (display) return JSON.stringify([state.topology_id, state.display, state.screen_width, state.screen_height, state.scale_factor]);
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
    private readonly retainRaw?: (image: Content) => void,
    private readonly launchWeb?: WebLauncher) {}

  private overviewSettings(): CuaVisionSettings {
    const settings = this.settings();
    return { ...settings, kernel: this.driver.overviewKernel ?? settings.kernel };
  }
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
    // The aria snapshot follows the JSON as plain YAML instead of an escaped string.
    const display = extra.dom ? { ...details, dom: { ...extra.dom, snapshot: undefined } } : extra.sequence ? { ...details, sequence: { ...extra.sequence, source: extra.sequence.frames[0]?.source,
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
    return { content: [{ type: "text", text: `${message}${summary}\n${visible}${extra.dom ? `\n${extra.dom.snapshot}` : ""}` }, ...images], details,
      ...(["refused", "unknown"].includes(status) ? { isError: true } : {}) };
  }

  private allowed(entry: WindowEntry): boolean {
    return this.getMode() === "yolo" || entry.owned;
  }

  private denied(ref: string): ComputerResult {
    return this.result("refused", "Safe mode allows only windows opened by this session. Only the user can change mode with /computer-mode.",
      undefined, { window_ref: ref });
  }

  private addressed(entry: WindowEntry, nativeDesktop?: unknown): Partial<ComputerResult["details"]> {
    return { target: entry.target, window_ref: entry.ref,
      source_identity: sourceIdentity({ session_id: this.sessionId, window_ref: entry.ref, ...entry.target }, null, nativeDesktop, this.platform) };
  }

  private async failed(error: unknown, dispatched: boolean): Promise<ComputerResult> {
    this.entries.clear(); this.displayEntries.clear(); this.displayOverview = undefined; this.uiImages = []; this.sequences.clear();
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
    if (this.driver.windowLifetime === false) return undefined;
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !Number.isSafeInteger(target.window_id) || target.window_id <= 0)
      return undefined;
    const identity = await this.driver.identity(target, true, signal);
    if (!identity) return undefined;
    for (const entry of this.entries.values()) {
      if (entry.target.pid === target.pid && entry.target.window_id === target.window_id && entry.identity === identity) return entry;
    }
    const entry: WindowEntry = { ref: "w-" + randomUUID(), target: { pid: target.pid, window_id: target.window_id }, identity, owned: false,
      web: this.browsers.get(`${target.pid}:${target.window_id}`) };
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
          windows.push({ ...native, ...(entry ? { ...this.addressed(entry, native.virtual_desktop), owned: entry.owned } : { unavailable: this.driver.windowLifetime === false ? `window_lifetime_unavailable: ${this.platform}. Window control is deferred; no reusable-ID substitute.` : "Cannot establish window lifetime identity.",
            source_identity: sourceIdentity({ session_id: this.sessionId, pid: native.pid as number, window_id: native.window_id as number }, null, undefined, this.platform) }) });
        }
        return this.result("listed", "Permitted window discovery. Safe lists session-opened windows only. Use window_ref only where native lifetime is supported; Linux/macOS currently expose metadata without control. Native desktop membership is sampled and incomplete; discovery does not activate or switch desktops.",
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
        const apps = (state.apps as App[]).filter(app => (app.launch_path || app.bundle_id) && (!query || app.name.toLowerCase().includes(query.toLowerCase())))
          .map(app => ({ ...app, app_id: app.launch_path ?? app.bundle_id }));
        return this.result("listed", "Installed native apps. Open by exact name or app_id when window lifetime is supported.", { platform: this.platform, apps });
      } catch (error) { return this.failed(error, false); }
    });
  }

  /**
   * Launch one new visible browser through Playwright with a disposable profile, then bind its native window.
   * Personal browsers are never attached. Closing the session closes this browser and deletes its profile.
   */
  openBrowser(options: WebLaunchOptions = {}, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted || !this.launchWeb || this.driver.windowLifetime === false)
        return this.result("refused", "Opening a browser needs Windows window lifetime and the Playwright browser backend; nothing was launched.");
      let launched: Awaited<ReturnType<WebLauncher>> | undefined;
      try {
        launched = await this.launchWeb(options, signal);
        const { pid } = launched.opened;
        // Chromium creates its native window asynchronously after Playwright sees the first page.
        let windows: Record<string, unknown>[] = [];
        for (let attempt = 0; attempt < 20 && !windows.length; attempt++) {
          if (attempt) await delay(250, undefined, { signal });
          windows = ((await this.state("list_windows", { pid }, signal)).windows as Record<string, unknown>[] ?? []).filter(window => window.pid === pid);
        }
        if (windows.length !== 1) throw Error(`Expected one native window for browser process ${pid}, found ${windows.length}.`);
        const target = windows[0] as unknown as WindowTarget;
        this.browsers.set(`${target.pid}:${target.window_id}`, launched.browser);
        const entry = await this.register(target, signal);
        if (!entry) throw Error("The browser window lifetime could not be established.");
        entry.owned = true;
        return this.result("observed", "Opened a new visible browser with a disposable profile. Read its window with dom for page structure, or with image/ui/full for native pixels and Windows UI.",
          { operation: "open_browser", ...launched.opened }, { ...this.addressed(entry), opened: true });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (!launched) return this.result("refused", `Browser launch failed: ${reason}`, { operation: "open_browser" });
        for (const [key, browser] of this.browsers) if (browser === launched.browser) this.browsers.delete(key);
        const cleanup = await launched.browser.close().then(() => "confirmed", () => "unconfirmed");
        return this.result(cleanup === "confirmed" ? "refused" : "unknown", `The browser started but its window could not be bound, so it was closed (cleanup ${cleanup}). ${reason}`,
          { operation: "open_browser", cleanup });
      }
    });
  }
  /** Launch once, establish a genuinely new window, and return its first UI observation. No shell strings from the model. */
  open(app: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before app opening.");
      if (this.driver.windowLifetime === false) return this.result("refused",
        `window_lifetime_unavailable: ${this.platform}. Window opening/control is deferred; no application was launched.`);
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
        const settings = { ...this.overviewSettings(), ...(options.maxLongEdge !== undefined ? { maxLongEdge: options.maxLongEdge } : {}),
          ...(options.scale !== undefined ? { scale: options.scale } : {}) };
        const cap = nativeImageCap(settings);
        if (entry) { entry.dom = undefined; entry.windowState = undefined; entry.observation = undefined; entry.detail = undefined; }
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
          let source = this.source(entry ? "window" : "display", state, entry
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
  /** Enumerate native Windows monitors in YOLO. References grant read access, never input. */
  displays(signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const denied = () => { this.displayEntries.clear(); return this.result("refused", "Safe mode forbids display discovery; native metadata withheld."); };
      if (this.getMode() !== "yolo") return denied();
      if (!this.driver.selectedDisplays) return this.result("refused", "Selected displays require an explicitly qualified Windows runtime.");
      if (signal?.aborted) return this.result("refused", "Cancelled before display discovery.");
      try {
        const state = await this.state("list_displays", {}, signal);
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) return this.result("refused", "Cancelled during display discovery; metadata withheld.");
        if (state.platform !== "windows" || typeof state.topology_id !== "string" || !state.topology_id || !Array.isArray(state.displays) || !state.displays.length)
          throw new Error("CUA returned no native Windows display inventory.");
        const topology = state.topology_id;
        const displays = state.displays.map(nativeDisplay);
        if (new Set(displays.map(d => d.display_id)).size !== displays.length) throw new Error("CUA returned duplicate native display identities.");
        const current = new Set<string>();
        const addressed = displays.map(d => {
          let entry = [...this.displayEntries.values()].find(e => e.topology === topology && e.native.display_id === d.display_id);
          if (!entry) { entry = { ref: "d-" + randomUUID(), topology, native: d }; this.displayEntries.set(entry.ref, entry); }
          current.add(entry.ref);
          return { ...d, display_ref: entry.ref, source_identity: sourceIdentity({ session_id: this.sessionId, display_ref: entry.ref, display_id: d.display_id, topology_id: topology }, d.display_id) };
        });
        for (const ref of this.displayEntries.keys()) if (!current.has(ref)) this.displayEntries.delete(ref);
        return this.result("listed", "Native connected Windows displays. Use display_ref with computer_observe. Image pixels start at zero; bounds are host-global. No input authority.",
          { platform: "windows", topology_id: topology, displays: addressed });
      } catch (error) {
        this.displayEntries.clear();
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) return this.result("refused", "Cancelled during display discovery; metadata withheld.");
        return this.result("refused", `Native display discovery failed. ${error instanceof Error ? error.message : error}`);
      }
    });
  }

  private readDisplay(entry: DisplayEntry | undefined, cap: number, signal?: AbortSignal): Promise<DriverResult> {
    return entry ? this.driver.call("get_display_state", { display_id: entry.native.display_id, topology_id: entry.topology, max_image_dimension: cap }, signal)
      : this.driver.call("get_desktop_state", { max_image_dimension: cap }, signal);
  }

  private displayStateMatches(state: Record<string, unknown> | undefined, entry?: DisplayEntry): state is Record<string, unknown> {
    if (!state || state.platform !== "windows") return false;
    if (!entry) return state.display === "primary";
    const d = nativeDisplay(state.display);
    return state.topology_id === entry.topology && d.display_id === entry.native.display_id &&
      state.screenshot_original_width === d.bounds.width && state.screenshot_original_height === d.bounds.height;
  }
  /** Read primary or a discovered native display in YOLO. Display pixels never ground input. */
  observeDisplay(display: string, signal?: AbortSignal, zoom?: DetailRequest): Promise<ComputerResult> {
    return this.queue(async () => {
      const denied = () => {
        this.displayOverview = undefined; this.displayEntries.clear();
        return this.result("refused", "Safe mode forbids full-display reading. Only the user can select YOLO with /computer-mode.");
      };
      if (this.getMode() !== "yolo") return denied();
      if (signal?.aborted) return this.result("refused", "Cancelled before display capture.");
      const entry = display === "primary" ? undefined : this.displayEntries.get(display);
      if (display !== "primary" && (!this.driver.selectedDisplays || !entry)) return this.result("refused", "Unknown or unavailable display reference. Discover native displays again; no primary fallback.");
      if (zoom) return this.displayDetail(zoom, signal, entry);
      const retire = () => { if (entry) entry.detail = undefined; else this.displayOverview = undefined; };
      retire();
      try {
        const settings = { ...this.overviewSettings() }; const cap = nativeImageCap(settings);
        const native = await this.readDisplay(entry, cap, signal);
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) return this.result("refused", "Cancelled during display capture; pixels withheld.");
        const state = native.structuredContent;
        if (native.isError || state?.status === "refused" || state?.effect === "refused") {
          if (entry) this.displayEntries.delete(entry.ref);
          return this.result("refused", "CUA refused exact-display capture. Discover again; no fallback.");
        }
        const images = native.content.filter(block => block.type === "image" && block.mimeType === "image/png");
        if (!this.displayStateMatches(state, entry) || images.length !== 1 ||
          !Number.isSafeInteger(state!.screenshot_width) || !Number.isSafeInteger(state!.screenshot_height) ||
          (state!.screenshot_width as number) <= 0 || (state!.screenshot_height as number) <= 0 ||
          Math.max(state!.screenshot_width as number, state!.screenshot_height as number) > cap)
          throw new Error("CUA returned no valid scoped display image.");
        const source = entry ? selectedDisplaySource(state!, this.sessionId, entry.ref) : this.source("display", state!, { session_id: this.sessionId, display_id: "primary" });
        const id = randomUUID(); const context = this.overview(state!, id, true, images);
        if (entry) { if (!context) throw new Error("CUA returned invalid selected-display raster geometry."); entry.detail = context; }
        else this.displayOverview = context;
        // The installed optional human overlay understands only primary. Clear it for selected monitors rather than drawing on the wrong source.
        const highlight = await notifyHighlight(this.observer, !entry && context ? { display: "primary", bounds: { x: 0, y: 0, width: context.originalWidth, height: context.originalHeight } } : undefined, signal);
        if (entry && highlight) highlight.reason = "selected_display_overlay_unsupported";
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) { retire(); return this.result("refused", "Cancelled during display frame; pixels withheld."); }
        return this.result("observed", `Native display ${entry?.native.display_id ?? "primary"} overview: ${state!.screenshot_width}x${state!.screenshot_height} local pixels. Read only; zoom uses this image_id. Paint freshness is unverified.`,
          state, { source, ...(highlight ? { highlight } : {}), agent_image: { ...this.imageMetadata(images, state!, settings), image_id: id } }, images);
      } catch (error) {
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) { retire(); return this.result("refused", "Cancelled during display capture; diagnostics withheld."); }
        return this.failed(error, false);
      }
    });
  }

  private async displayDetail(request: DetailRequest, signal?: AbortSignal, entry?: DisplayEntry): Promise<ComputerResult> {
    const overview = entry ? entry.detail : this.displayOverview;
    let cap: number;
    try { cap = validateDetail(request, overview, false); }
    catch (error) { return this.result("refused", (error as Error).message); }
    if (entry) entry.detail = undefined; else this.displayOverview = undefined;
    try {
      if (this.getMode() !== "yolo" || signal?.aborted) return this.result("refused", "Display detail permission or request cancelled.");
      const native = await this.readDisplay(entry, 0, signal);
      if (this.getMode() !== "yolo" || signal?.aborted) return this.result("refused", "Display detail revoked or cancelled; pixels withheld.");
      const state = native.structuredContent;
      const images = native.content.filter((block): block is Extract<Content, { type: "image" }> => block.type === "image");
      if (entry && (native.isError || state?.status === "refused" || state?.effect === "refused")) this.displayEntries.delete(entry.ref);
      if (native.isError || state?.status === "refused" || state?.effect === "refused" || !this.displayStateMatches(state, entry) ||
        images.length !== 1 || state.screenshot_width !== overview!.originalWidth || state.screenshot_height !== overview!.originalHeight ||
        this.geometry(state, true) !== overview!.geometry)
        return this.result("refused", "Fresh display geometry or capture is incompatible. Take a new overview.");
      const capturedAt = new Date().toISOString();
      const region = nativeRegion(request, overview!);
      const detail = await cropDisplay(images[0], overview!, region, cap);
      if (this.getMode() !== "yolo" || signal?.aborted) return this.result("refused", "Display detail revoked or cancelled during processing; pixels withheld.");
      const output = { screenshot_width: detail.width, screenshot_height: detail.height, display: entry ? state!.display : "primary", topology_id: entry?.topology };
      const source = entry ? selectedDisplaySource({ ...state, ...output }, this.sessionId, entry.ref) : this.source("display", output, { session_id: this.sessionId, display_id: "primary" });
      source.captured_at = capturedAt;
      source.image.scope = entry ? "selected_display_region" : "primary_display_region"; source.image.coordinate_space = "detail_image_pixels"; source.capabilities.detail = "unsupported";
      source.image.original_dimensions = { width: overview!.originalWidth, height: overview!.originalHeight };
      source.image.origin = { x: region.left, y: region.top, relative_to: entry ? "display" : "primary_display" };
      const configuration = { maxLongEdge: request.maxLongEdge ?? 1200, scale: request.scale ?? 1, kernel: "lanczos3" as const, version: 0, route: "cua_native" as const };
      const agent_image = { ...this.imageMetadata([detail.image], output, configuration), route: "cua_fresh_display_crop",
        coordinate_space: "detail_image_pixels", configuration: { ...configuration, route: "adapter_crop_resize" },
        region: { overview: { image_id: overview!.id, dimensions: { width: overview!.width, height: overview!.height }, x: request.x, y: request.y, width: request.width, height: request.height }, native: region },
        native: { resolution: "full", intermediate_pixels: "withheld" }, input: "none" };
      const highlight = await notifyHighlight(this.observer, entry ? undefined : { display: "primary",
        bounds: { x: 0, y: 0, width: overview!.originalWidth, height: overview!.originalHeight },
        mark: { kind: "detail", region: { x: region.left, y: region.top, width: region.width, height: region.height } } }, signal);
      if (entry && highlight) highlight.reason = "selected_display_overlay_unsupported";
      if (this.getMode() !== "yolo" || signal?.aborted) return this.result("refused", "Display detail revoked or cancelled during frame; pixels withheld.");
      return this.result("observed", `Fresh display ${entry?.native.display_id ?? "primary"} crop: native-local ${region.left},${region.top} ${region.width}x${region.height}, output ${detail.width}x${detail.height}. Read only; no nested crop or input. Paint freshness is unverified.`,
        undefined, { source, agent_image, ...(highlight ? { highlight } : {}) }, [detail.image]);
    } catch { return this.result("refused", "Display detail failed; private intermediate pixels and diagnostics withheld. Take a new overview."); }
  }

  private async windowDetail(entry: WindowEntry, request: DetailRequest, signal?: AbortSignal): Promise<ComputerResult> {
    if (entry.observation?.backend === "wgc") return this.result("refused", "Native zoom/crop does not support WGC. Read an overview with capture.backend: default to use native detail.");
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
      const source = this.source("window", state, { session_id: this.sessionId, window_ref: entry.ref, ...entry.target }, true);
      source.capabilities.input = "none"; source.semantic_scope = "none";
      const image = images[0] as Extract<Content, { type: "image" }>; const bytes = Buffer.from(image.data, "base64");
      const windows = await this.list(signal);
      if (!this.allowed(entry) || signal?.aborted) return this.result("refused", "Window detail revoked or cancelled; pixels withheld.");
      const window = windows.find(w => w.pid === entry.target.pid && w.window_id === entry.target.window_id);
      if (!window) return this.result("refused", "Window closed during detail; pixels withheld.");
      const bounds = screenRect(window.bounds);
      Object.assign(source, sourceIdentity(source.identity, null, window.virtual_desktop, this.platform));
      const highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, bounds, signal,
        { kind: "detail", region: bounds ? windowRegion(request, overview!.windowMapping, bounds) : undefined });
      if (!this.allowed(entry) || signal?.aborted) return this.result("refused", "Window detail revoked or cancelled during frame; pixels withheld.");
      return this.result("observed", "Fresh native window zoom. CUA owns JPEG padding and geometry. Read only; take a new overview before input or another detail.",
        undefined, { ...this.addressed(entry, window.virtual_desktop), ...(highlight ? { highlight } : {}), source, agent_image: { route: "cua_fresh_window_zoom", coordinate_space: "zoom_image_pixels",
          configuration: { padding: "20% each side", maxWidth: 500, route: "cua_native" }, native: state,
          region: { overview: { image_id: overview!.id, dimensions: { width: overview!.width, height: overview!.height }, x: request.x, y: request.y, width: request.width, height: request.height } },
          output: { width: state.width, height: state.height, bytes: bytes.length, mimeType: image.mimeType, hash: createHash("sha256").update(bytes).digest("hex") }, input: "none" } }, images);
    } catch { return this.result("refused", "Window detail failed; pixels and diagnostics withheld. Observe again."); }
  }
  private async capture(entry: WindowEntry, signal?: AbortSignal, query?: string, options: UiCaptureOptions = {}): Promise<ComputerResult> {
    validateUiCapture(options);
    entry.dom = undefined; entry.windowState = undefined;
    const granularity = options.granularity ?? "full";
    const hasUi = granularity !== "image"; const hasImage = granularity !== "ui";
    if (!hasUi && query !== undefined) return this.result("refused", "Image-only observation cannot query UI labels.");
    const wgc = options.backend === "wgc" || (options.backend === undefined && hasImage && this.driver.persistentWgc === true);
    if (wgc && this.driver.persistentWgc !== true) return this.result("refused", "WGC needs an explicitly selected, qualified Windows runtime. Default capture is unchanged.");
    if (!this.allowed(entry)) return this.denied(entry.ref);
    entry.observation = undefined; entry.detail = undefined;
    const current = await this.current(entry.ref, signal);
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (!current) return this.result("refused", "Window closed or its native handle was reused. Discover again.");
    const settings = structuredClone({ ...this.overviewSettings(), ...(options.maxLongEdge !== undefined ? { maxLongEdge: options.maxLongEdge } : {}),
      ...(options.scale !== undefined ? { scale: options.scale } : {}), ...(options.hints !== undefined ? { hints: options.hints } : {}), ...(options.guides ? { guides: options.guides } : {}) });
    const native = await this.driver.call("get_window_state", {
      ...entry.target,
      ...(hasUi ? { max_elements: options.max_elements ?? 200, max_depth: options.max_depth ?? 15, timeout_ms: 5000, ...(query ? { query } : {}) }
        : { include_accessibility_tree: false }),
      ...(hasImage ? { max_image_dimension: nativeImageCap(settings) } : { include_screenshot: false }),
      ...(wgc ? { capture_backend: "wgc" } : {}),
    }, signal);
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (signal?.aborted) return this.result("refused", "Cancelled during observation; captured data withheld.");
    if (native.isError) return this.result("refused", "Driver refused observation.", native.structuredContent, this.addressed(entry, native.structuredContent?.virtual_desktop));
    if (!native.structuredContent) throw new Error("Driver returned no structured window state.");
    const state = { ...native.structuredContent };
    if (hasImage && typeof state.screenshot_error === "string" && state.screenshot_error.trim()) {
      if (!await this.current(entry.ref, signal)) return this.result("refused", "Window changed during observation. Discover again.");
      if (!this.allowed(entry)) return this.denied(entry.ref);
      if (signal?.aborted) return this.result("refused", "Cancelled during observation; diagnostics withheld.");
      const screenshot_error = state.screenshot_error.trim().slice(0, 2000);
      return this.result("refused", `Window screenshot unavailable. Native reason: ${screenshot_error}`,
        { screenshot_error }, this.addressed(entry, state.virtual_desktop));
    }
    const backend = state.capture_backend as { backend?: unknown } | undefined;
    if (wgc && (backend?.backend !== "wgc" || typeof state.capture_id !== "string" || !state.capture_id))
      return this.result("refused", "WGC returned no bound WGC capture receipt; pixels and input authority withheld.");
    // Native screenshot-only reads may preserve their old AX snapshot. Never expose it as current.
    if (!hasUi) for (const key of ["elements", "tree_markdown", "snapshot_id", "invalidated_snapshot_ids", "elements_complete", "truncated", "truncation_reason", "total_element_count", "element_count", "focused_element"]) delete state[key];
    // Tree-only native receipts can describe an older pixel frame. It gives this observation no image authority.
    if (!hasImage) for (const key of Object.keys(state)) if (key.startsWith("screenshot_") || ["capture_id", "agent_overlay_capture", "capture_backend"].includes(key)) delete state[key];
    if (hasUi && !Array.isArray(state.elements)) throw new Error("Driver returned no structured UI elements.");
    if (hasUi && !hasImage) state.elements = (state.elements as Record<string, unknown>[]).map(element => {
      const { screenshot_frame: _oldPixels, ...current } = element; return current;
    });
    const images = hasImage ? native.content.filter(block => block.type === "image") : [];
    if (hasImage && !images.length) throw new Error("Driver returned no grounding screenshot.");
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (!await this.current(entry.ref, signal)) return this.result("refused", "Window changed during observation. Discover again.");
    if (!this.allowed(entry)) return this.denied(entry.ref);
    const id = randomUUID();
    entry.detail = hasImage ? this.overview(state, id, false, images) : undefined;
    if (granularity === "image" && !entry.detail) throw Error("Driver returned no proven image-only pixel geometry.");
    const ui = hasUi ? createUiResource(state, entry.ref, id, ++this.uiSerial) : undefined;
    if (ui && !hasImage) for (const element of ui.elements) {
      delete element.bounds.window_image; element.hint_display = "off";
    }
    const elements = hasUi ? state.elements as { element_token?: unknown; frame?: unknown }[] : [];
    entry.observation = { id, ui, settings, ...(wgc ? { backend: "wgc" as const } : {}),
      width: hasImage && typeof state.screenshot_width === "number" ? state.screenshot_width : undefined,
      height: hasImage && typeof state.screenshot_height === "number" ? state.screenshot_height : undefined,
      tokens: new Set(elements.map(element => element.element_token).filter((token): token is string => typeof token === "string")),
      captureId: hasImage && typeof state.capture_id === "string" ? state.capture_id : undefined,
      bounds: screenRect(state.window_bounds),
      frames: new Map(elements.flatMap(element => {
        const bounds = screenRect(state.window_bounds); const region = bounds && elementRegion(element.frame, bounds);
        return typeof element.element_token === "string" && region ? [[element.element_token, region] as [string, ScreenRect]] : [];
      })) };
    if (signal?.aborted) { entry.observation = undefined; entry.detail = undefined; return this.result("refused", "Cancelled during observation; captured data withheld."); }
    const source = this.source("window", state, { session_id: this.sessionId, window_ref: entry.ref, ...entry.target });
    if (!hasUi) source.semantic_scope = "none";
    if (!hasImage || wgc) source.capabilities.detail = "unsupported";
    const highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, state.window_bounds, signal);
    if (!this.allowed(entry)) { entry.observation = undefined; entry.detail = undefined; return this.denied(entry.ref); }
    if (signal?.aborted) { entry.observation = undefined; entry.detail = undefined; return this.result("refused", "Cancelled during window frame; captured data withheld."); }
    const observed = entry.observation!;
    observed.source = source;
    const extra = { ...this.addressed(entry, state.virtual_desktop), ...(highlight ? { highlight } : {}), observation_id: id,
      source, granularity, captured: { image: hasImage, ui: hasUi } };
    if (!hasImage) return this.result("observed", `Fresh UI-only window observation: ${ui!.elements.length} UI elements. No pixels or image detail; current hints/tokens only.`, state, { ...extra, ui: structuredClone(ui!) });
    const raw = images[0];
    if (raw?.type === "image" && Buffer.byteLength(raw.data, "base64") <= 12 * 1024 * 1024) {
      observed.rawImage = raw;
      const active = new Set([...this.entries.values()].map(e => e.observation));
      this.uiImages = [...this.uiImages.filter(old => active.has(old)), observed];
      for (const old of this.uiImages.splice(0, Math.max(0, this.uiImages.length - 3))) old.rawImage = undefined;
    }
    observed.mapping = entry.detail?.windowMapping;
    observed.actionMark = this.actionMark(entry.lastAction, observed.mapping);
    const annotationUi = ui ?? createUiResource({ elements: [] }, entry.ref, id, 0);
    const rendered = await annotateUi(raw, annotationUi, observed.width, observed.height, hasUi && (options.hints ?? settings.hints ?? true), undefined, annotationUi.elements,
      { options: settings.guides, action: observed.actionMark });
    if (!this.allowed(entry) || signal?.aborted) { entry.observation = undefined; entry.detail = undefined; return this.result("refused", "Observation revoked or cancelled during annotation; pixels withheld."); }
    if (rendered.image !== raw) this.retainRaw?.(raw);
    const metadata = this.imageMetadata([rendered.image], state, settings);
    const message = hasUi
      ? `Fresh full window observation: ${ui!.elements.length} UI elements; ${rendered.annotation.labels.length} image hints. Structure ${ui!.complete === true ? "complete" : ui!.complete === false ? "partial" : "completeness unknown"}; paint freshness is unverified. Hints belong to this observation only.`
      : "Fresh image-only window observation. Accessibility was not collected; no current UI hints/tokens. Pixel input uses this window image; paint freshness is unverified.";
    return this.result("observed", `${message}${wgc ? " Retained WGC capture; native detail is not supported on this route." : ""}`, state, { ...extra, ...(ui ? { ui: structuredClone(ui) } : {}),
      agent_image: { ...metadata, ...(rendered.image !== raw ? { route: "cua_native_ui_hints" } : {}), annotation: rendered.annotation, image_id: id } }, [rendered.image]);
  }

  /** Resolve a permitted window bound to a browser this session opened through Playwright. */
  private async webEntry(ref: string, signal?: AbortSignal): Promise<WindowEntry | ComputerResult> {
    let entry: WindowEntry | undefined;
    try { entry = await this.current(ref, signal); }
    catch (error) { return this.result("refused", `Window lifetime check failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!entry) return this.entries.has(ref) ? this.denied(ref) : this.result("refused", "Unknown or closed window. Discover again.");
    if (!entry.web) return this.result("refused", "DOM is available only in browsers opened with Insert {\"action\":\"open_browser\"} into computer:session. Use image/ui/full Reads for other windows.",
      undefined, this.addressed(entry));
    return entry;
  }

  private webFailure(entry: WindowEntry, error: unknown, acting = false): ComputerResult {
    const reason = error instanceof Error ? error.message : String(error);
    const uncertain = acting && error instanceof WebError && (error.timeout || error.transport);
    return this.result(uncertain ? "unknown" : "refused", uncertain
      ? `The action may have reached the page. ${reason} Read the window with dom before deciding; never replay it blindly.`
      : `Playwright refused: ${reason}`, undefined, this.addressed(entry));
  }

  /** Store a page snapshot as the window's only current DOM observation. */
  private webObservation(entry: WindowEntry, page: WebPage): { id: string; page: WebDom } {
    const truncated = page.snapshot.length > WEB_SNAPSHOT_LIMIT;
    entry.dom = { id: randomUUID(), page: { ...page, truncated,
      snapshot: truncated ? page.snapshot.slice(0, WEB_SNAPSHOT_LIMIT) + "\n# Snapshot truncated; narrow it with dom:{\"target\":...,\"depth\":...}." : page.snapshot } };
    return entry.dom;
  }

  /** Fresh Playwright aria snapshot ("ai" mode, iframes included) of the page shown in an owned browser window. */
  observeDom(ref: string, options: WebSnapshotOptions = {}, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = await this.webEntry(ref, signal);
      if (!("ref" in entry)) return entry;
      entry.dom = undefined; entry.windowState = undefined; entry.observation = undefined; entry.detail = undefined;
      try {
        const observed = this.webObservation(entry, await entry.web!.page("snapshot", options, signal));
        return this.result("observed", "Fresh Playwright aria snapshot. Use [ref=...] values as target.ref while this stays the latest snapshot of the window.",
          undefined, { ...this.addressed(entry), observation_id: observed.id, dom: observed.page });
      } catch (error) { return this.webFailure(entry, error); }
    });
  }

  /** Return the window's current DOM observation without querying the page. */
  checkDom(ref: string, id: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = await this.webEntry(ref, signal);
      if (!("ref" in entry)) return entry;
      if (entry.dom?.id !== id) return this.result("refused", "This DOM observation is no longer current. Read the window with dom again.", undefined, this.addressed(entry));
      return this.result("observed", "Cached Playwright aria snapshot; the page may have changed since.", undefined,
        { ...this.addressed(entry), observation_id: id, dom: entry.dom.page });
    });
  }

  /** Filter the current snapshot's lines without querying the page. */
  searchDom(ref: string, id: string, query: string, limit = 50, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = await this.webEntry(ref, signal);
      if (!("ref" in entry)) return entry;
      if (entry.dom?.id !== id) return this.result("refused", "This DOM observation is no longer current. Read the window with dom again.", undefined, this.addressed(entry));
      const needle = query.toLowerCase();
      const lines = entry.dom.page.snapshot.split("\n").filter(line => line.toLowerCase().includes(needle));
      return this.result("observed", `${lines.length} snapshot lines match. Search covers only this snapshot${entry.dom.page.truncated ? ", which was truncated" : ""}.`, undefined,
        { ...this.addressed(entry), observation_id: id, dom: { ...entry.dom.page, snapshot: lines.slice(0, limit).join("\n"), matches: lines.length } });
    });
  }

  /** Playwright screenshot of the page viewport, one element, or the viewport with that element highlighted. */
  webImage(ref: string, id: string, kind: "page" | "crop" | "highlight", target?: WebTarget, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = await this.webEntry(ref, signal);
      if (!("ref" in entry)) return entry;
      if (entry.dom?.id !== id) return this.result("refused", "This DOM observation is no longer current. Read the window with dom again.", undefined, this.addressed(entry));
      try {
        const shot = await entry.web!.request<{ url: string; title: string; png: string; box?: unknown }>("screenshot",
          { ...(target ? { target } : {}), highlight: kind === "highlight" }, signal);
        const bytes = Buffer.from(shot.png, "base64");
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error("Playwright did not return a PNG.");
        return this.result("observed", `Playwright ${kind === "page" ? "page viewport" : kind === "crop" ? "element" : "highlighted viewport"} screenshot. These are page pixels, not native window coordinates; they grant no input.`,
          { url: shot.url, title: shot.title, ...(shot.box ? { box_css: shot.box } : {}) },
          { ...this.addressed(entry), observation_id: id, agent_image: { route: "playwright_screenshot", kind, coordinate_space: "page_image_pixels", input_authority: false,
            output: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length, mimeType: "image/png",
              hash: createHash("sha256").update(bytes).digest("hex") } } },
          [{ type: "image", data: shot.png, mimeType: "image/png" }]);
      } catch (error) { return this.webFailure(entry, error); }
    });
  }

  /** Run one Playwright action against the current DOM observation and return the next snapshot. */
  actDom(ref: string, id: string, action: WebAction, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = await this.webEntry(ref, signal);
      if (!("ref" in entry)) return entry;
      if (entry.dom?.id !== id) return this.result("refused", "This DOM observation is no longer current. Read the window with dom again; nothing was sent.", undefined, this.addressed(entry));
      entry.dom = undefined; entry.windowState = undefined; entry.observation = undefined; entry.detail = undefined;
      try {
        const observed = this.webObservation(entry, await entry.web!.page("act", action, signal));
        return this.result("delivered", `Playwright performed ${action.action}${action.target && action.action !== "evaluate" ? " after its actionability checks" : ""}. Check the fresh snapshot below for the application's response.`,
          undefined, { ...this.addressed(entry), observation_id: observed.id, dom: observed.page });
      } catch (error) { return this.webFailure(entry, error, true); }
    });
  }

  /** Acquire fresh one-use native state without pixels, a UI walk or ordinary-input authority. */
  observeWindowState(ref: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      try {
        const known = this.entries.get(ref);
        if (known && !this.allowed(known)) return this.denied(ref);
        if (known) { known.dom = undefined; known.windowState = undefined; known.observation = undefined; known.detail = undefined; }
        if (signal?.aborted) return this.result("refused", "Cancelled before window state acquisition.");
        const entry = await this.current(ref, signal);
        if (!entry) return this.result("refused", "Unknown, closed or reused window. Discover again.");
        if (!this.driver.windowRestore && !this.driver.windowManagement) return this.result("refused", "Window state needs an explicitly selected qualified native runtime. Ask the user to manage the window manually; no keys or clicks as a workaround.", undefined, this.addressed(entry));
        const kind = this.driver.windowManagement ? "management" : "restore";
        const native = await this.driver.call(kind === "management" ? "get_window_control_state" : "get_window_status", { ...entry.target }, signal);
        if (!this.allowed(entry)) return this.denied(ref);
        if (signal?.aborted) return this.result("refused", "Cancelled during window state acquisition; no authority issued.");
        if (!await this.current(ref, signal)) return this.result("refused", "Window closed or was reused during state acquisition.");
        if (!this.allowed(entry) || signal?.aborted) return this.result("refused", "Window state revoked or cancelled; no authority issued.");
        const state = native.structuredContent;
        if (native.isError || !state || !(kind === "management" ? validWindowControlState(state, entry.target) : validWindowStatus(state, entry.target)) ||
          native.content.some(block => block.type === "image"))
          return this.result("refused", "Native window state refused or its exact-source receipt is invalid. No input fallback.", state, this.addressed(entry));
        const id = randomUUID();
        entry.windowState = { id, nativeId: state.state_id as string, kind };
        return this.result("observed", kind === "management"
          ? "Fresh native control state. One Insert move/resize/minimize/maximize/focus or explicit restore consumes this state. Desktop-frame units are not pointer coordinates."
          : "Fresh native window state. Insert restore explicitly restores and activates this exact window once. No pixels, UI hints, typing or pointer authority.", state,
          { ...this.addressed(entry, kind === "management" ? (state.state as Record<string, unknown>).virtual_desktop : undefined), window_state_id: id, window_state_kind: kind });
      } catch (error) { return this.failed(error, false); }
    });
  }

  /** Check cached state authority without acquiring metadata or renewing its one-use native lease. */
  checkWindowState(ref: string, id: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      try {
        const known = this.entries.get(ref);
        if (known && !this.allowed(known)) return this.denied(ref);
        if (signal?.aborted) return this.result("refused", "Cancelled before window state reference check.");
        const entry = await this.current(ref, signal);
        if (!entry || entry.windowState?.id !== id) return this.result("refused", "Retired or closed window state. Read a fresh state.");
        if (!this.allowed(entry)) return this.denied(ref);
        if (signal?.aborted) return this.result("refused", "Window state reference check cancelled.");
        return this.result("observed", "Existing window state; no native acquisition or renewal of one-use authority.", undefined,
          { ...this.addressed(entry), window_state_id: id, window_state_kind: entry.windowState.kind });
      } catch (error) { return this.failed(error, false); }
    });
  }
  /** Consume one admitted window state for explicit restore and activation; never capture, inject input or replay. */
  restoreWindow(ref: string, id: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = this.entries.get(ref), observed = entry?.windowState;
      if (!entry || !observed || observed.id !== id) return this.result("refused", "Retired or missing window state. Read a new state before restore.");
      entry.dom = undefined; entry.windowState = undefined; entry.observation = undefined; entry.detail = undefined;
      if (!this.allowed(entry)) return this.denied(ref);
      if (signal?.aborted) return this.result("refused", "Cancelled before native restore dispatch.");
      let dispatched = false;
      try {
        if (!await this.current(ref, signal)) return this.result("refused", "Window closed or was reused before restore.");
        if (!this.allowed(entry)) return this.denied(ref);
        if (signal?.aborted) return this.result("refused", "Cancelled before native restore dispatch.");
        if (!this.driver.windowRestore) return this.result("refused", "Native restore is unavailable. Ask the user to restore manually; no input fallback.");
        dispatched = true;
        const native = await this.driver.call("restore_window", { ...entry.target, state_id: observed.nativeId }, signal);
        const status = windowRestoreStatus(native.structuredContent, entry.target, observed.nativeId, native.isError === true);
        // A transport cancellation, lost identity or permission change cannot retract a submitted native transition.
        // Keep the native receipt even when this final identity check fails or throws.
        let current = false;
        try { current = !!await this.current(ref, signal); } catch { /* The delivered prefix remains available below. */ }
        const outcome = signal?.aborted || !this.allowed(entry) || !current ? "unknown" : status;
        const message = outcome === "delivered" ? "Native restoration and target foreground confirmed. Keyboard focus is measured separately; Read fresh pixels to inspect paint."
          : outcome === "refused" ? "Native restore refused before mutation. Ask the user to restore manually; no keys or clicks were used."
          : "Restore outcome incomplete or unknown. Retained native prefix follows; do not replay. Read fresh window state/pixels before deciding.";
        return this.result(outcome, message, native.structuredContent, this.addressed(entry));
      } catch (error) { return this.failed(error, dispatched); }
    });
  }
  /** Consume admitted control state once; retain unknown native prefixes without replay or input fallback. */
  manageWindow(ref: string, id: string, command: WindowManagementCommand, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = this.entries.get(ref), observed = entry?.windowState;
      if (!entry || !observed || observed.id !== id) return this.result("refused", "Retired or missing window state. Read a fresh state.");
      entry.dom = undefined; entry.windowState = undefined; entry.observation = undefined; entry.detail = undefined;
      if (!this.allowed(entry)) return this.denied(ref);
      if (signal?.aborted) return this.result("refused", "Cancelled before native management dispatch.");
      let dispatched = false;
      try {
        if (!await this.current(ref, signal)) return this.result("refused", "Window closed or was reused before management.");
        if (!this.allowed(entry)) return this.denied(ref);
        if (signal?.aborted) return this.result("refused", "Cancelled before native management dispatch.");
        if (observed.kind !== "management" || !this.driver.windowManagement)
          return this.result("refused", "This state/runtime does not admit management. Read qualified control state; no input fallback.");
        const { action, ...geometry } = command;
        dispatched = true;
        const native = await this.driver.call("manage_window", { ...entry.target, state_id: observed.nativeId, operation: action, ...geometry }, signal);
        const status = native.content.some(block => block.type === "image") ? "unknown"
          : windowManagementStatus(native.structuredContent, entry.target, observed.nativeId, command, native.isError === true);
        let current = false;
        try { current = !!await this.current(ref, signal); } catch { /* Preserve the submitted prefix. */ }
        const outcome = signal?.aborted || !this.allowed(entry) || !current ? "unknown" : status;
        return this.result(outcome, outcome === "delivered"
          ? "Native management postcondition confirmed. Foreground/focus are separate measurements; Read fresh pixels to inspect paint."
          : outcome === "refused" ? "Native management refused before mutation. No input fallback."
          : "Management outcome incomplete or unknown. Retained native prefix follows; do not replay. Read fresh state/pixels.",
          native.structuredContent, this.addressed(entry));
      } catch (error) { return this.failed(error, dispatched); }
    });
  }
  /** Read fresh window parts for an existing reference. Each mode retires this window's previous observation. */
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
    if (!observed.ui) return this.result("refused", "Image-only observation has no UI resource. Request a UI or full observation.");
    if (!observed.width && ["highlight", "scope", "crop", "region"].includes(request.operation))
      return this.result("refused", "This local image operation needs a full observation; UI-only captured no pixels.");
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
  /** Check an issued observation for cached resource reading without capturing or renewing input authority. */
  checkObservation(target: { window_ref?: string; display?: string }, id: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before observation reference check.");
      if ((target.window_ref !== undefined) === (target.display !== undefined))
        return this.result("refused", "Choose one observed window or display reference.");
      if (target.display !== undefined) {
        if (this.getMode() !== "yolo") return this.result("refused", "Safe mode forbids display observation reading.");
        const detail = target.display === "primary" ? this.displayOverview : this.displayEntries.get(target.display)?.detail;
        return detail?.id === id ? this.result("observed", "Existing read-only display observation; no fresh pixels or input authority.")
          : this.result("refused", "Retired display observation. Read a new overview.");
      }
      try {
        const known = this.entries.get(target.window_ref!);
        if (known && !this.allowed(known)) return this.denied(known.ref);
        const entry = await this.current(target.window_ref!, signal);
        if (!entry || entry.observation?.id !== id) return this.result("refused", "Retired or closed window observation. Read a new overview.");
        if (!this.allowed(entry)) return this.denied(entry.ref);
        if (signal?.aborted) return this.result("refused", "Observation reference check cancelled.");
        return this.result("observed", "Existing window observation; no native capture or renewal of input authority.", undefined,
          { ...this.addressed(entry), observation_id: id });
      } catch (error) { return this.failed(error, false); }
    });
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
      const { window_ref: _ref, observation_id: _id, delivery_mode, animation, ...command } = action;
      const batch = command.action === "sequence";
      let commands: InputStep[];
      try {
        if (delivery_mode !== undefined && !["background", "foreground"].includes(delivery_mode)) throw new Error("Unsupported delivery mode.");
        if (animation !== undefined && (animation !== "reactive" || !this.driver.reactiveAnimation))
          throw Error("Reactive animation requires the scoped native cursor adapter; no input was dispatched.");
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
            if (!observed.ui) throw Error("Image-only observation has no current hints.");
            nativeStep.element_token = resolveUi(observed.ui, hint).element_token;
          }
          const element = observed.ui?.elements.find(e => e.element_token === nativeStep.element_token);
          if (element?.enabled === false) throw Error("The observed target is disabled. No input was dispatched.");
          if (!isSemanticAction(nativeStep.action) && element?.bounds.window_image && observed.width && observed.height) {
            const r = element.bounds.window_image;
            if (r.x >= observed.width || r.y >= observed.height || r.x + r.width <= 0 || r.y + r.height <= 0)
              throw Error("The observed target is outside the image. No input was dispatched.");
          }
          validateInput(nativeStep, observed, batch);
          if (isCoordinateScroll(nativeStep)) {
            if (!this.driver.coordinateScroll) throw Error("Coordinate scroll requires the explicitly selected native scroll runtime. No input was dispatched.");
            if (animation !== undefined) throw Error("Native coordinate scroll has no overlay animation.");
            if (!observed.captureId) throw Error("Coordinate scroll needs this overview's native capture. Observe again.");
          }
          if (isPointerMove(nativeStep.action)) {
            if (!this.driver.nativePointer) throw Error("Pointer movement requires the explicitly selected native pointer runtime. No input was dispatched.");
            if (animation !== undefined) throw Error("Native pointer movement has no overlay animation.");
            if (nativeStep.element_token ? !observed.frames.has(nativeStep.element_token) : !observed.captureId)
              throw Error("Pointer movement needs a current token with proven geometry or this overview's native capture. Observe again.");
          }
          if (isSemanticAction(nativeStep.action)) {
            if (!this.driver.semanticActions) throw Error("Semantic actions require the explicitly selected qualified Windows semantic runtime. No input was dispatched.");
            if (delivery_mode === "foreground" || animation !== undefined) throw Error("Semantic actions use accessibility only: no foreground or cursor animation.");
          }
          return nativeStep;
        });
        if (this.driver.captureBoundDrag && !observed.captureId && commands.some(step => step.action === "drag" && step.via === undefined))
          throw new Error("Straight drag requires this overview's native capture. Observe again; no batch input was dispatched.");
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
          const { name, args } = nativeInput(step, entry.target, delivery_mode ?? "background", observed.captureId, this.driver.captureBoundDrag);
          // AX bounds are native. Only native click receipts establish an exact pixel action mark.
          const mark = { kind: "action" as const, region: step.element_token ? observed.frames.get(step.element_token) : undefined };
          let highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, observed.bounds, signal, mark);
          if (signal?.aborted) return finish(this.result("refused", "Cancelled during action mark; input was not dispatched."), "Cancelled during action mark.");
          if (!this.allowed(entry)) return finish(this.denied(entry.ref), "Permission revoked during action mark.");
          if (batch && performance.now() - started >= 45000) return finish(this.result("refused", "Sequence time budget reached."), "45s elapsed budget reached during admission; no more steps dispatched.");
          entry.observation = undefined; entry.detail = undefined;
          const pointerAction = isPointerMove(step.action) || isCoordinateScroll(step) || ["click", "right_click", "double_click", "drag"].includes(step.action) || (step.action === "hold" && !!step.actions?.length);
          if (pointerAction) entry.lastAction = { reason: "Pointer outcome is not yet confirmed." };
          const requested = { ...step, ...(step.text !== undefined ? { text_length: step.text.length } : {}),
            ...(step.via ? { via_points: step.via.length } : {}), ...(step.actions ? { actions: step.actions.map(pointer => { const { via, ...compact } = pointer; return { ...compact, ...(via ? { via_points: via.length } : {}) }; }) } : {}) };
          delete requested.text; delete requested.element_token;
          delete requested.via;
          const row: Record<string, unknown> = { index, action: step.action, native_tool: name, requested,
            requested_wait_ms: step.wait_ms ?? 0, dispatch_ms: performance.now() - started, status: "unknown" };
          trace.steps.push(row); trace.attempted++; inFlight = true;
          const native = animation
            ? await this.driver.call(name, args, signal, { animation })
            : await this.driver.call(name, args, signal);
          row.completion_ms = performance.now() - started;
          if (!this.allowed(entry) || signal?.aborted) return finish(this.result("unknown",
            "Input was dispatched before permission was revoked or cancellation. Outcome withheld; native input may still have completed. Do not replay blindly."),
            "In-flight outcome withheld after revocation/cancellation.");
          const state = native.structuredContent ?? {};
          const refused = state.status === "refused" || state.effect === "refused" || ["invalid_action_target", "invalid_arguments", "stale_element_token",
            "conflicting_element_target", "background_unavailable", "background_occluded", "background_uipi_blocked", "key_hold_unavailable", "held_path_unavailable"].includes(String(state.code));
          const uncertain = native.isError || ["unknown", "partial"].includes(String(state.status)) || ["unknown", "partial"].includes(String(state.effect));
          const inconsistent = !refused && !uncertain && (isSemanticAction(step.action) ? !semanticReceipt(step.action, state)
            : isPointerMove(step.action) ? delivery_mode !== "foreground" || !pointerReceipt(step, state)
            : isCoordinateScroll(step) && (delivery_mode !== "foreground" || !scrollReceipt(step, state)));
          const status = refused ? "refused" : uncertain || inconsistent ? "unknown" : "delivered";
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
          const result = this.result(status, `Driver returned ${status} for ${name} (requested: ${delivery_mode ?? "background"}). ${isSemanticAction(step.action) ? "A UIA receipt is not app or focus verification. " : ""}Observe again to verify application state.${step.action === "hold" && typeof state.summary === "string" ? `\n${state.summary}` : ""}`,
            { ...state, ...(step.element_token || pointerAction ? { coordinate_grounding: { input_space: step.element_token ? "native_element_token" : "window_image_pixels", transform: "cua_native_once",
              overview: { width: observed.width, height: observed.height }, ...(step.x !== undefined ? { requested: { x: step.x, y: step.y } } : {}),
              resolved_native_screen: resolvedPoint ?? null, native_target_mark: isSemanticAction(step.action) ? null : entry.lastAction ?? null } } : {}),
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

  /** Close session-opened browsers (deleting their profiles) and release the native runtime. Other windows/files are not closed or saved. */
  close(): Promise<ComputerResult> {
    return this.queue(async () => {
      this.entries.clear(); this.displayEntries.clear(); this.displayOverview = undefined; this.uiImages = []; this.sequences.clear();
      const browsers = [...this.browsers.values()];
      this.browsers.clear();
      const cleanup = await Promise.allSettled(browsers.map(browser => browser.close()));
      await this.driver.close();
      const failed = cleanup.filter(result => result.status === "rejected").length;
      if (failed) return this.result("unknown", `Native runtime released, but cleanup of ${failed} of ${browsers.length} owned browsers is unconfirmed.`);
      return this.result("closed", "Owned computer-use runtime and session-opened browsers released. Other application documents were not closed or saved.");
    });
  }
}
