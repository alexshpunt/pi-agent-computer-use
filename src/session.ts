import { randomUUID, createHash } from "node:crypto";
import { nativeDisplay, selectedDisplaySource, type NativeDisplay } from "./selected-displays.ts";
import { collectSequence, cropSequenceFrame, frameSummary, runningSequenceMetadata, selectFrames, sequenceMetadata, SequenceStop, SequenceStore, validateSequence, type FrameSequence, type SequenceOptions, type FrameSelection, type SequenceFrame } from "./temporal-capture.ts";
import { changeLines, differs, frameChanges, framesBetween, sheetFrames, WATCH_LIMITS, WATCH_SHEET_FRAMES, writeWatchFiles, type WatchFiles, type WatchSpan } from "./watch.ts";
import type { PixelBox } from "./pixel-diff.ts";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFrames, type FrameMark, type FrameRendering, type RenderedFrames } from "./contact-sheet.ts";
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
import { DEFAULT_MAX_LONG_EDGE, FULL_RESOLUTION, nativeImageCap, type CuaVisionSettings } from "./cua-image-settings.ts";
import type { DisplayMode } from "./display-mode.ts";
import { WEBVIEW2_DEBUGGING, type MachineHost, type ProcessHealth, type TextLine } from "./machine-host.ts";
import { setTimeout as delay } from "node:timers/promises";
import { cropDisplay, nativeRegion, validateDetail, type DetailContext, type DetailRequest } from "./native-detail.ts";
import type { StateDiff } from "./successor.ts";
import { combine, evaluateNative, validateWait, type ConditionResult, type WaitResult, type WaitSpec } from "./ui-conditions.ts";
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
  /** Source domain override: a sandbox guest's windows are not host windows. */
  sourceDomain?: "windows-sandbox" | "windows-session" | "windows-remote";
  /** True only for a backend qualified for held paths and graceful in-flight release. */
  heldPaths?: boolean;
  /** True only for a qualified native runtime with bounded keyboard ownership. */
  heldKeys?: boolean;
  /** True only for a qualified Windows runtime with exact selected-display read contracts. */
  selectedDisplays?: boolean;
  /** True only for a qualified native runtime that admits both straight-drag endpoints against one capture. */
  captureBoundDrag?: boolean;
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
  /** Fixed overview filter of the selected native runtime; never a tool-controlled resize switch. */
  overviewKernel?: CuaVisionSettings["kernel"];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult>;
  identity(target: WindowTarget, create: boolean, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * A second driver process on the same desktop for captures that run while this one acts: a driver answers one call
   * at a time, so a capture sent during a long drag would wait for its end. Absent where only one connection exists.
   */
  companion?(): Driver | undefined;
  close(): Promise<void>;
}
/** One complete action or bounded known-target sequence, grounded in one window overview. */
export type Action = {
  window_ref: string;
  observation_id: string;
  delivery_mode?: "background" | "foreground";
  /** A click or scroll on an element token goes through UI Automation only; the driver refuses when no pattern carries it. */
  uia_only?: boolean;
} & (InputCommand | { action: "sequence"; sequence: InputStep[] });
/** A stored Playwright snapshot of the active tab, with the tab list, any held dialog and events since the previous snapshot. */
export interface WebDom extends WebPage { truncated: boolean; matches?: number }
/** Delivery is not a task postcondition. Unknown input is never automatically replayed. */
export interface ComputerResult {
  content: Content[];
  details: {
    status: "listed" | "observed" | "delivered" | "refused" | "unknown" | "closed";
    /** The machine the request ran on, by its address name; set by the computer resources for every routed request. */
    machine?: string;
    /** The sandbox or isolated session on that machine the request ran in. */
    sandbox?: string;
    /** The sandbox an open_sandbox command started. */
    sandbox_ref?: string;
    mode: ComputerMode;
    target?: WindowTarget;
    window_ref?: string;
    /** The viewport a Read showed or an input acted in: rect in the window's full-resolution pixels, image the size of its image. */
    viewport?: { source: string; name: string; window_ref: string; rect: { x: number; y: number; width: number; height: number }; image: { width: number; height: number } };
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
    /** A finished sequence, or one still collecting (`running`), such as a watch just started. */
    sequence?: ReturnType<typeof sequenceMetadata> | ReturnType<typeof runningSequenceMetadata>;
    selected_frames?: Omit<SequenceFrame, "image">[];
    /** A watch this result started or stopped: what it watches, whether it still runs, the actions it noted and, once stopped, its files. */
    watch?: { sequence_id: string; watching: string; running: boolean; marks: FrameMark[]; changed_frames?: number; files?: WatchFiles };
    /** An action's span in each running watch of its window, in the watch's milliseconds, with the frames captured during it. */
    watch_spans?: WatchSpan[];
    /** How a sheet or composite Read placed the selected frames in its one image. */
    rendered_frames?: Omit<RenderedFrames, "png">;
    /** Outcome of a bounded wait_for/verify; the conditions as requested, in order. */
    verification?: WaitResult & { spec: WaitSpec };
    /** The observation taken after an action and its compact difference from the action's input observation. */
    successor?: { observation_id?: string; diff?: StateDiff; reason?: string };
    /** A `changes` Read: this UI compared with the window's previous observation, or why there is no comparison. */
    changes?: { since?: string; diff?: StateDiff; reason?: string };
    /** The UI walk as a Playwright aria snapshot (YAML), for an aria Read. */
    aria?: string;
    /** Icons and text areas found by Cua perception, boxes in the observation's overview pixels. */
    visual_regions?: VisualRegion[];
    /** Text recognised by Windows OCR in this result's image, boxes in the observation's overview pixels. */
    text_lines?: TextLine[];
    /** The window's process: whether it responds, its memory and CPU time. */
    process?: ProcessHealth;
    /** Complete text of one native element from its observation. */
    element_text?: { hint: string; role: string | null; name: string | null; text: string; cut: boolean };
  };
  isError?: boolean;
}
/** One icon or text area detected in an observation's pixels; the box is in its overview pixels. */
export interface VisualRegion { kind: "icon" | "text"; x: number; y: number; width: number; height: number; text?: string; label?: string; confidence: number }

interface Observation { texts?: Map<string, string>; id: string; tokens: Set<string>; width?: number; height?: number; captureId?: string; bounds?: ScreenRect; frames: Map<string, ScreenRect>; ui?: UiResource; rawImage?: Content; source?: ObservationSource; settings: CuaVisionSettings; actionMark?: GuideMark; mapping?: DetailContext["windowMapping"];
  /** Kept after pixel-only input: coordinates stay valid until a freshness check finds a changed size or state; UI tokens and the native capture are spent. */
  pixelsOnly?: boolean }
interface WindowState { id: string; nativeId: string; kind: "restore" | "management" }
/** The unannotated pixels of a window's latest capture with pixels, kept as the baseline of its next pixel comparison. */
export interface WindowFrame { observation_id: string; png: Buffer; size: { maxLongEdge: number; scale: number } }
interface WindowEntry { ref: string; target: WindowTarget; identity: string; owned: boolean; observation?: Observation;
  /** Size of the window's latest image capture: points of typed input are in its pixels. Outlives the observation. */
  seen?: { width: number; height: number };
  windowState?: WindowState; dom?: { id: string; page: WebDom }; web?: WebBrowser; detail?: DetailContext; lastAction?: GuideMark; frame?: WindowFrame }
interface App { name: string; launch_path?: string; bundle_id?: string; kind?: string }
/** A watch of a window: its growing sequence, when its clock started, the actions noted in it and how to stop it. */
interface Watching { window_ref: string; watching: string; sequence?: FrameSequence; started: number; marks: FrameMark[]; stop: AbortController; finished: boolean; done: Promise<FrameSequence> }
/** A discovery query: `regex:<pattern>` is a case-insensitive regular expression, anything else a case-insensitive substring. */
export function textMatcher(query?: string): (text: string) => boolean {
  if (!query) return () => true;
  if (query.startsWith("regex:")) {
    let pattern: RegExp;
    try { pattern = new RegExp(query.slice(6), "i"); }
    catch (error) { throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : error}`); }
    return text => pattern.test(text);
  }
  const needle = query.toLowerCase();
  return text => text.toLowerCase().includes(needle);
}
interface DisplayEntry { ref: string; topology: string; native: NativeDisplay; detail?: DetailContext }
/** One input sequence: enough for a long drawing or form program in one call, still bounded so a runaway program stops. */
export const SEQUENCE_STEPS = 2000;
/** Requested waits, typing and drag durations of one sequence. */
export const SEQUENCE_REQUESTED_MS = 15 * 60_000;
/** Wall-clock budget of one sequence, including native call overhead. */
export const SEQUENCE_ELAPSED_MS = 30 * 60_000;
/** Aria snapshots above this many characters are cut. Read pages stored snapshots with offset/limit. */
const WEB_SNAPSHOT_LIMIT = 400_000;
/** Longest native element text retained for element:text reads; the walk shows 1024 characters per element. */
const ELEMENT_TEXT_LIMIT = 200_000;
const appName = (name: string) => name.trim().toLowerCase().replace(/^windows\s+/, "").replace(/\.exe$/, "");
/** File name of a Win32 launch path without directory and extension; packaged shell:appsFolder paths have none. */
const executableName = (path: string) => /^shell:/i.test(path) ? "" : appName(path.split(/[\\/]/).pop() ?? "");

/** Multi-window UI policy. Native work is queued; ownership and observations are not persisted across reloads. */
export class ComputerSession {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, WindowEntry>();

  private readonly sessionId = randomUUID();
  private displayOverview?: DetailContext;
  private readonly displayEntries = new Map<string, DisplayEntry>();
  /** Modes this session replaced, by display device; close puts them back. */
  private readonly replacedModes = new Map<string, DisplayMode>();
  private recording?: { timer: NodeJS.Timeout; started: number };
  private recordings = 0;
  private audioClips = 0;
  private readonly sequences = new SequenceStore();
  /** Watches by sequence id until stopWatch reports them; they capture through `watcher`, a second driver where one exists. */
  private readonly watches = new Map<string, Watching>();
  private watcher?: Driver;
  /** Temporary folders of stopped watches' files, removed when the session closes. */
  private readonly watchDirs = new Set<string>();
  private uiSerial = 0;
  private uiImages: Observation[] = [];
  /**
   * Playwright browsers opened by this session, keyed by `pid:window_id` of the window bound at launch.
   * Popup windows of the same process are ordinary native windows; their pages are reached as tabs of this browser.
   */
  private readonly browsers = new Map<string, WebBrowser>();

  private get platform(): NativePlatform { return this.driver.platform ?? "windows"; }
  /** Label sources from a sandbox guest so they never pass for host windows or displays. */
  private domained<T extends { domain: SourceIdentity["domain"] }>(value: T): T {
    if (this.driver.sourceDomain) value.domain = this.driver.sourceDomain;
    return value;
  }

  private source(kind: ObservationSource["kind"], native: Record<string, unknown>, identity: ObservationSource["identity"], zoom = false): ObservationSource {
    return this.domained(observationSource(kind, native, identity, zoom, this.platform));
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
    private readonly settings: () => CuaVisionSettings = () => ({ kernel: "lanczos3", maxLongEdge: DEFAULT_MAX_LONG_EDGE, scale: 1, version: 0, route: "cua_native" }),
    private readonly observer?: WindowObserver,
    private readonly retainRaw?: (image: Content) => void,
    private readonly launchWeb?: WebLauncher,
    /** Display modes, the owned file folder, process health and OCR on this desktop's machine; absent in a sandbox guest. */
    readonly host?: MachineHost) {}

  private overviewSettings(): CuaVisionSettings {
    const settings = this.settings();
    return { ...settings, kernel: this.driver.overviewKernel ?? settings.kernel };
  }
  private queue<T = ComputerResult>(work: () => Promise<T>): Promise<T> {
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
      source_identity: this.domained(sourceIdentity({ session_id: this.sessionId, window_ref: entry.ref, ...entry.target }, null, nativeDesktop, this.platform)) };
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
        const matches = textMatcher(query);
        const windows = [];
        const owned = [...this.entries.values()].filter(entry => entry.owned);
        const nativeWindows = this.getMode() === "safe" && !owned.length ? [] : await this.list(signal);
        for (const native of nativeWindows) {
          // An anchored regex names the title or the app alone, so each is tried as well as both together.
          if (![native.title, native.app_name, `${native.app_name} ${native.title}`].some(text => matches(String(text ?? "")))) continue;
          const known = owned.find(entry => entry.target.pid === native.pid && entry.target.window_id === native.window_id);
          const entry = this.getMode() === "safe"
            ? known && await this.current(known.ref, signal)
            : await this.register(native as unknown as WindowTarget, signal);
          if (this.getMode() === "safe" && (!entry || !entry.owned)) continue;
          windows.push({ ...native, ...(entry ? { ...this.addressed(entry, native.virtual_desktop), owned: entry.owned } : { unavailable: this.driver.windowLifetime === false ? `window_lifetime_unavailable: ${this.platform}. Window control is deferred; no reusable-ID substitute.` : "Cannot establish window lifetime identity.",
            source_identity: this.domained(sourceIdentity({ session_id: this.sessionId, pid: native.pid as number, window_id: native.window_id as number }, null, undefined, this.platform)) }) });
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
        const matches = textMatcher(query);
        const apps = (state.apps as App[]).filter(app => (app.launch_path || app.bundle_id) && matches(app.name))
          .map(app => ({ ...app, app_id: app.launch_path ?? app.bundle_id }));
        return this.result("listed", "Installed native apps. Open by exact name or app_id when window lifetime is supported.", { platform: this.platform, apps });
      } catch (error) { return this.failed(error, false); }
    });
  }

  /**
   * Launch one new visible browser through Playwright with a disposable profile, or in YOLO the agent's persistent
   * profile, then bind its native window. Closing the session closes this browser and deletes a disposable profile.
   * attachBrowser covers browsers that already run.
   */
  openBrowser(options: WebLaunchOptions = {}, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted || !this.launchWeb || this.driver.windowLifetime === false)
        return this.result("refused", "Opening a browser needs Windows window lifetime and the Playwright browser backend; nothing was launched.");
      if (options.profile && this.getMode() !== "yolo")
        return this.result("refused", "The agent's persistent browser profile keeps logins, so Safe mode allows only disposable profiles. Only the user can select YOLO with /computer-mode.");
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
        return this.result("observed", `Opened a new visible browser with ${options.profile ? "the agent's persistent profile (logins made in it stay for later sessions)" : "a disposable profile"}. Read its window with dom for page structure, or with image/ui/full for native pixels and Windows UI.`,
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
  /**
   * Attach Playwright to the running Chromium-based browser that shows this window (YOLO only): Chrome and Edge, or a
   * browser embedded in another app (Electron, CEF, WebView2, VS Code's integrated browser). The wait for approval
   * runs outside the session queue, so another call can approve the extension's page with ordinary input meanwhile.
   * Closing the session detaches; the browser and its tabs stay open.
   */
  async attachBrowser(ref: string, signal?: AbortSignal): Promise<ComputerResult> {
    const prepared = await this.queue<ComputerResult | { pid: number; title: string }>(async () => {
      if (signal?.aborted || !this.launchWeb || this.driver.windowLifetime === false)
        return this.result("refused", "Attaching needs Windows window lifetime and the Playwright browser backend; nothing was attached.");
      if (this.getMode() !== "yolo")
        return this.result("refused", "Attaching Playwright to an existing browser exposes its signed-in sessions, so Safe mode allows only browsers the session opened. Only the user can select YOLO with /computer-mode.");
      const entry = await this.current(ref, signal);
      if (!entry) return this.result("refused", "Unknown or closed window. Discover again.");
      if (entry.web) return this.result("refused", "Playwright already works in this browser; read the window with dom.", undefined, this.addressed(entry));
      const windows = (await this.state("list_windows", { pid: entry.target.pid }, signal)).windows as Record<string, unknown>[] ?? [];
      const title = windows.find(window => window.window_id === entry.target.window_id)?.title;
      return { pid: entry.target.pid, title: typeof title === "string" ? title : "" };
    });
    if ("content" in prepared) return prepared;
    let launched: Awaited<ReturnType<WebLauncher>>;
    try { launched = await this.launchWeb!({ attach: prepared }, signal); }
    catch (error) { return this.result("refused", `Attaching failed: ${error instanceof Error ? error.message : String(error)}`, { operation: "attach_browser" }); }
    return this.queue(async () => {
      const entry = this.entries.get(ref);
      if (!entry || entry.web) {
        const cleanup = await launched.browser.close().then(() => "confirmed", () => "unconfirmed");
        return this.result("refused", `The window closed or Playwright attached to it meanwhile, so this attachment was released (detach ${cleanup}).`, { operation: "attach_browser" });
      }
      this.browsers.set(`${entry.target.pid}:${entry.target.window_id}`, launched.browser);
      entry.web = launched.browser;
      const via = { cdp: "its debugging endpoint", toggle: "the remote debugging turned on in the browser", extension: "the Playwright Extension", vscode: "VS Code's browser bridge" }[launched.opened.via ?? "extension"];
      return this.result("delivered", `Attached Playwright to this browser through ${via}. Read the window with dom for its active tab; every tab is listed there and switch_tab changes the active one. Closing the computer session detaches without closing the browser.`,
        { operation: "attach_browser", ...launched.opened }, this.addressed(entry));
    });
  }
  /**
   * Open a new window of an installed app, or in YOLO an executable by its Windows path with command-line
   * arguments (for example an app with a script to run). The result binds exactly one genuinely new window.
   */
  open(app: string | { path: string; args: string[]; debugging?: boolean }, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before app opening.");
      if (this.driver.windowLifetime === false) return this.result("refused",
        `window_lifetime_unavailable: ${this.platform}. Window opening/control is deferred; no application was launched.`);
      if (typeof app !== "string" && this.getMode() !== "yolo")
        return this.result("refused", "Starting an executable by path with arguments runs arbitrary programs; Safe mode allows only installed apps by name. Only the user can select YOLO with /computer-mode.");
      let dispatched = false;
      try {
        if (typeof app !== "string") {
          const name = app.path.split("\\").at(-1)!.replace(/\.exe$/i, "");
          if (app.debugging) {
            // WebView2 reads its Chromium switches from the environment, which CUA's launch cannot set.
            if (!this.host) return this.result("refused", "Starting with WebView2 debugging needs this machine's Windows host; nothing was launched.");
            const host = this.host;
            return await this.launchNew({ name }, async () => ({ pid: await host.startProcess(app.path, app.args, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: WEBVIEW2_DEBUGGING }) }), signal, () => dispatched = true);
          }
          return await this.launchNew({ name }, () => this.state("launch_app", { path: app.path, additional_arguments: app.args }, signal), signal, () => dispatched = true);
        }
        const state = await this.state("list_apps", {}, signal);
        if (!Array.isArray(state.apps)) throw new Error("Driver returned no app list.");
        const apps = (state.apps as App[]).filter(item => item.launch_path);
        const exact = apps.filter(item => appName(item.name) === appName(app) || item.launch_path === app || item.bundle_id === app);
        // An executable name such as "notepad" is used only when no installed name or app_id matches.
        const matches = exact.length ? exact : apps.filter(item => executableName(item.launch_path!) === appName(app));
        const paths = [...new Map(matches.map(item => [item.launch_path, item])).values()];
        if (paths.length !== 1) {
          if (paths.length) return this.result("refused", `Ambiguous app name: ${paths.slice(0, 5).map(item => item.name).join(", ")}. Open one by its exact app_id.`);
          const wanted = appName(app);
          const close = [...new Set(apps.map(item => item.name).filter(name => { const have = appName(name); return have.length > 2 && (wanted.includes(have) || have.includes(wanted)); }))];
          return this.result("refused", `Installed app not found.${close.length ? ` Did you mean: ${close.slice(0, 5).join(", ")}?` : ""} Search the machine's apps (computer:machine/<name>/apps) for exact names.`);
        }
        const selected = paths[0];
        const aumid = selected.launch_path!.match(/^shell:appsFolder\\(.+!.+)$/i)?.[1];
        return await this.launchNew(selected, () => this.state("launch_app", aumid ? { aumid } : { launch_path: selected.launch_path }, signal), signal, () => dispatched = true);
      } catch (error) { return this.failed(error, dispatched); }
    });
  }

  /** Launch with native arguments and bind the one new window of that process or app; called inside the queue. */
  private async launchNew(selected: { name: string }, start: () => Promise<Record<string, unknown>>, signal: AbortSignal | undefined, dispatch: () => void): Promise<ComputerResult> {
    const before = new Set<string>();
    for (const native of await this.list(signal)) before.add(`${native.pid}:${native.window_id}`);
    if (signal?.aborted) return this.result("refused", "Cancelled before launch dispatch.");
    dispatch();
    const launched = await start();
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
        if ((target.window_ref !== undefined) === (target.display !== undefined)) return this.result("refused", "Choose exactly one window or display.");
        const entry = target.window_ref ? this.entries.get(target.window_ref) : undefined;
        // primary is the machine's main display; any other display is one its displays listing issued.
        const display = target.display !== undefined && target.display !== "primary" ? this.displayEntries.get(target.display) : undefined;
        if (target.display !== undefined && target.display !== "primary" && (!this.driver.selectedDisplays || !display))
          return this.result("refused", "Unknown or unavailable display reference. Read the machine's displays again; no primary fallback.");
        const permitted = () => entry ? this.allowed(entry) : target.display !== undefined && this.getMode() === "yolo";
        const denied = () => { this.sequences.clear(); return this.result("refused", "Sequence source access denied. Safe permits session-owned windows only; retained pixels withheld."); };
        if (!permitted()) return denied();
        const settings = { ...this.overviewSettings(), ...(options.maxLongEdge !== undefined ? { maxLongEdge: options.maxLongEdge } : {}),
          ...(options.scale !== undefined ? { scale: options.scale } : {}) };
        const cap = nativeImageCap(settings);
        if (entry) { entry.dom = undefined; entry.windowState = undefined; entry.observation = undefined; entry.detail = undefined; }
        else if (display) display.detail = undefined;
        else this.displayOverview = undefined;
        let first = true;
        const sequence = await collectSequence(options, async active => {
          if (!permitted()) throw new SequenceStop("access_revoked");
          if (entry && !await this.current(entry.ref, active)) throw new SequenceStop("target_lost");
          if (!permitted()) throw new SequenceStop("access_revoked");
          const nativeStarted = performance.now();
          const native = entry ? await this.driver.call("get_window_state", { ...entry.target, include_accessibility_tree: false, max_image_dimension: cap }, active)
            : await this.readDisplay(display, cap, active);
          const native_completed_at = performance.now();
          if (!permitted()) throw new SequenceStop("access_revoked");
          active.throwIfAborted();
          const state = native.structuredContent;
          if (native.isError || !state || state.status === "refused" || state.effect === "refused") throw new SequenceStop("capture_failed");
          if (!entry && !this.displayStateMatches(state, display)) throw new SequenceStop("capture_failed");
          if (entry && ((state.pid !== undefined && state.pid !== entry.target.pid) ||
            (state.window_id !== undefined && state.window_id !== entry.target.window_id))) throw new SequenceStop("target_lost");
          const images = native.content.filter((block): block is SequenceFrame["image"] => block.type === "image");
          const context = this.overview(state, "sequence-frame", !entry, images);
          if (!context || Math.max(context.width, context.height) > cap || images[0].data.length > 16 * 1024 * 1024)
            throw new SequenceStop("capture_failed");
          let source = display ? selectedDisplaySource(state, this.sessionId, display.ref) : this.source(entry ? "window" : "display", state, entry
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
  sequenceFrames(id: string, selection: FrameSelection, signal?: AbortSignal, rendering?: FrameRendering): Promise<ComputerResult> {
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
        if (rendering) {
          let rendered;
          try { rendered = await renderFrames(frames, rendering); }
          catch (error) { return this.result("refused", `Frames not rendered: ${error instanceof Error ? error.message : error}`); }
          if (signal?.aborted) return this.result("refused", "Cancelled during frame rendering; pixels withheld.");
          if (!permitted()) return denied();
          const { png, ...layout } = rendered;
          const crop = layout.region ? ` of region ${layout.region.x},${layout.region.y} ${layout.region.width}x${layout.region.height}` : "";
          const summary = rendering.as === "sheet"
            ? `Contact sheet of ${frames.length} frames${crop}: ${layout.columns}x${layout.rows} tiles of ${layout.tiles[0].width}x${layout.tiles[0].height} in time order, left to right, each under its "#index · time" label; image ${layout.width}x${layout.height}.\n` +
              layout.tiles.map((tile, i) => `Tile ${i + 1} (row ${Math.floor(i / layout.columns!) + 1}, column ${i % layout.columns! + 1}): frame ${tile.index} at ${tile.timestamp_ms.toFixed(1)} ms`).join("\n")
            : `Per-pixel ${rendering.as === "max" ? "maximum" : "minimum"} of ${frames.length} frames${crop} (frames ${frames.map(frame => frame.index).join(", ")}); image ${layout.width}x${layout.height}. ` +
              `${rendering.as === "max" ? "Bright" : "Dark"} detail from any frame shows at once, for example text revealed by a moving light.`;
          return this.result("observed", `${summary}\nRead only; observe again before input.`, undefined, { selected_frames: metadata, rendered_frames: layout },
            [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
        }
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

  /**
   * Start watching a window, or with `crop` (a viewport's rectangle in full-resolution window pixels) a part of it.
   * Frames come from a second driver process in the background, outside the session's queue, so the agent acts
   * meanwhile and a long drag is seen while it runs. Returns once the first frame is in; the sequence then grows until
   * stopWatch, its time limit, its frame or byte limit, or the session closing.
   */
  async startWatch(window_ref: string, watching: string, options: { fps: number; timeout_ms: number; maxLongEdge: number; crop?: PixelBox }, signal?: AbortSignal): Promise<ComputerResult> {
    const entry = this.entries.get(window_ref);
    if (!entry || !this.allowed(entry)) return this.result("refused", "Unknown or unavailable window reference. Search its machine's windows again.");
    const permitted = () => this.entries.get(window_ref) === entry && this.allowed(entry);
    const driver = this.watcher ??= this.driver.companion?.() ?? this.driver;
    // Watch frames come from the window's own pixels at a size that gives the crop maxLongEdge pixels on its long edge.
    let cap = Math.min(FULL_RESOLUTION, options.maxLongEdge);
    const fullSize = (state: Record<string, unknown>) => {
      const width = state.screenshot_original_width, height = state.screenshot_original_height;
      if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return undefined;
      const fit = Math.min(1, FULL_RESOLUTION / Math.max(width, height));
      return { width: Math.round(width * fit), height: Math.round(height * fit) };
    };
    if (options.crop) {
      let probe: DriverResult;
      try { probe = await driver.call("get_window_state", { ...entry.target, include_accessibility_tree: false, max_image_dimension: 64 }, signal); }
      catch (error) { return this.result("refused", `The watch did not start: ${error instanceof Error ? error.message : error}`); }
      const full = probe.isError || !probe.structuredContent ? undefined : fullSize(probe.structuredContent);
      if (!full) return this.result("refused", "The watch did not start: the window could not be captured.");
      const long = Math.max(options.crop.width, options.crop.height);
      cap = Math.max(64, Math.min(FULL_RESOLUTION, Math.ceil(Math.max(full.width, full.height) * Math.min(options.maxLongEdge, long) / long)));
    }
    const capture = async (active: AbortSignal) => {
      if (!permitted()) throw new SequenceStop(this.entries.has(window_ref) ? "access_revoked" : "target_lost");
      const nativeStarted = performance.now();
      const native = await driver.call("get_window_state", { ...entry.target, include_accessibility_tree: false, max_image_dimension: cap }, active);
      const native_completed_at = performance.now();
      active.throwIfAborted();
      if (!permitted()) throw new SequenceStop(this.entries.has(window_ref) ? "access_revoked" : "target_lost");
      const state = native.structuredContent;
      if (native.isError || !state || state.status === "refused" || state.effect === "refused") throw new SequenceStop("capture_failed");
      // Identity is not asked here: its peer takes one request at a time and the session's own calls use it.
      if ((state.pid !== undefined && state.pid !== entry.target.pid) || (state.window_id !== undefined && state.window_id !== entry.target.window_id))
        throw new SequenceStop("target_lost");
      const images = native.content.filter((block): block is SequenceFrame["image"] => block.type === "image");
      const context = this.overview(state, "watch-frame", false, images);
      if (!context || Math.max(context.width, context.height) > cap || images[0].data.length > 16 * 1024 * 1024) throw new SequenceStop("capture_failed");
      let source = this.source("window", state, { session_id: this.sessionId, window_ref, ...entry.target });
      source.semantic_scope = "none"; source.capabilities = { read: true, input: "none", detail: "unsupported" };
      let image = images[0];
      const full = options.crop && fullSize(state);
      if (options.crop && full) {
        // The viewport follows the window: its rectangle is relative to the window's top-left corner.
        const kx = context.width / full.width, ky = context.height / full.height, crop = options.crop;
        const region = { x: Math.round(crop.x * kx), y: Math.round(crop.y * ky), width: Math.max(1, Math.round(crop.width * kx)), height: Math.max(1, Math.round(crop.height * ky)) };
        if (region.x >= context.width || region.y >= context.height) throw new SequenceStop("capture_failed");
        ({ image, source } = await cropSequenceFrame(image, source, region, false));
      }
      return { image, source, native_completed_at, native_latency_ms: native_completed_at - nativeStarted };
    };
    const stop = new AbortController();
    const watch: Watching = { window_ref, watching, started: 0, marks: [], stop, finished: false, done: Promise.resolve(undefined as unknown as FrameSequence) };
    watch.done = collectSequence({ duration_ms: options.timeout_ms, fps: options.fps, max_frames: WATCH_LIMITS.max_frames, timeout_ms: options.timeout_ms + 20_000 }, capture,
      undefined, undefined, { limits: WATCH_LIMITS, stop: stop.signal, started: (sequence, at) => {
        watch.sequence = sequence; watch.started = at;
        sequence.configuration = { ...this.overviewSettings(), maxLongEdge: cap };
        this.sequences.put(sequence, true);
        this.watches.set(sequence.sequence_id, watch);
      } }).then(sequence => {
      watch.finished = true;
      if (this.watches.get(sequence.sequence_id) === watch) this.sequences.put(sequence);
      return sequence;
    });
    // Return with the first frame, so a watch that cannot capture says so now; starting the second driver takes a few seconds.
    const deadline = performance.now() + 30_000;
    while (!watch.finished && !watch.sequence?.frames.length && performance.now() < deadline && !signal?.aborted) await delay(20);
    const sequence = watch.sequence!;
    if (!sequence?.frames.length) {
      stop.abort();
      const ended = await watch.done;
      this.watches.delete(ended.sequence_id);
      return this.result("refused", `The watch did not start: ${signal?.aborted ? "cancelled" : ended.stop_reason === "stopped" ? "no frame came within 30 s" : ended.stop_reason}.`);
    }
    const size = sequence.frames[0].source.image.dimensions;
    return this.result("observed", `Watching ${watching} at up to ${options.fps} FPS in the background, ${size.width}x${size.height} frames. ` +
      `Act on the window as usual: each action's receipt names its span and frames in this watch. Read the sequence with frames:last for the newest frame; computer_record watch_stop at the sequence returns the contact sheet, change statistics and files. ` +
      `It stops by itself after ${Math.round(options.timeout_ms / 1000)} s or ${WATCH_LIMITS.max_frames} frames, and when the session closes.`,
      undefined, { ...this.addressed(entry), sequence: runningSequenceMetadata(sequence, performance.now() - watch.started), watch: { sequence_id: sequence.sequence_id, watching, running: true, marks: [] } });
  }

  /** Note an action on a window in each running watch of it: the action's span in the watch's time and the frames captured during it so far. */
  markWatches(window_ref: string, label: string, start: number, end: number): WatchSpan[] {
    const spans: WatchSpan[] = [];
    for (const watch of this.watches.values()) {
      if (watch.window_ref !== window_ref || watch.finished || !watch.sequence) continue;
      const mark = { label, start_ms: start - watch.started, end_ms: end - watch.started };
      watch.marks.push(mark);
      spans.push({ sequence_id: watch.sequence.sequence_id, label, from_ms: mark.start_ms, to_ms: mark.end_ms, frames: framesBetween(watch.sequence.frames, mark.start_ms, mark.end_ms) });
    }
    return spans;
  }
  /** Whether this sequence is a watch that has not been stopped with stopWatch yet. */
  isWatch(id: string): boolean { return this.watches.has(id); }

  /**
   * Stop a watch: a contact sheet of the frames that changed with the actions marked, change statistics of every
   * frame, and the frames as files in `dir` (a temporary folder removed when the session closes, unless given), with an
   * animated WebP when asked. The sequence keeps its frames for frames: Reads.
   */
  async stopWatch(id: string, files: { dir?: string; animation?: boolean } = {}): Promise<ComputerResult> {
    const watch = this.watches.get(id);
    if (!watch) return this.result("refused", this.sequences.get(id) ? "This sequence is no running watch; Read it with a frames: view." : "No watch of this session has this address. Watches do not survive reload or close.");
    watch.stop.abort();
    const sequence = await watch.done;
    this.watches.delete(id);
    const entry = this.entries.get(watch.window_ref);
    if (entry ? !this.allowed(entry) : this.getMode() !== "yolo") {
      this.sequences.clear();
      return this.result("refused", "The watched window is no longer accessible; its frames are withheld.");
    }
    const reasons: Record<FrameSequence["stop_reason"], string> = { stopped: "stopped", completed: "stopped by itself at its time limit", frame_limit: "stopped by itself at its frame limit",
      byte_limit: "stopped by itself at its memory limit", timeout: "stopped by itself at its time limit", cancelled: "cancelled", target_lost: "stopped: the window closed",
      access_revoked: "stopped: access to the window ended", capture_failed: "stopped: a capture failed" };
    const frames = sequence.frames;
    const changes = await frameChanges(frames);
    const distinct = frames.filter((_, i) => differs(frames, i)).length;
    const lines = [`Watch of ${watch.watching} ${reasons[sequence.stop_reason]}: ${frames.length} frames over ${(sequence.elapsed_ms / 1000).toFixed(1)} s` +
      `${sequence.actual_fps ? ` at ${sequence.actual_fps.toFixed(1)} FPS` : ""}; ${distinct === 1 ? "1 differs" : `${distinct} differ`} from the frame before.`];
    if (watch.marks.length) lines.push("Actions (ms of the watch):", ...watch.marks.map(mark => {
      const span = framesBetween(frames, mark.start_ms, mark.end_ms);
      return `- ${mark.label} ${Math.round(mark.start_ms)}–${Math.round(mark.end_ms)} ms, ${span ? `frames ${span.from}–${span.to}` : "no frame during it"}`;
    }));
    const moving = changeLines(changes, watch.marks);
    lines.push(moving.length ? "Biggest changes against the frame before (share of the frame's pixels, box in its pixels):" : "No frame changed against the one before.", ...moving);
    const content: Content[] = [];
    let rendered: Omit<RenderedFrames, "png"> | undefined;
    if (frames.length) {
      const { png, ...layout } = await renderFrames(sheetFrames(frames, watch.marks), { as: "sheet", marks: watch.marks });
      rendered = layout;
      lines.push(`Contact sheet: the frames that changed (at most ${WATCH_SHEET_FRAMES}, kept around each action and spread over the rest) and the last one, ${layout.columns}x${layout.rows} tiles in time order, each under "#index · time"; an orange label means an action ran then. Frames: ${layout.tiles.map(tile => `#${tile.index}`).join(", ")}.`);
      content.push({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    }
    const dir = files.dir ?? join(tmpdir(), "pi-computer-use-watch", id);
    let written: WatchFiles | undefined;
    try {
      written = await writeWatchFiles(dir, sequence, watch.marks, changes, { watching: watch.watching }, files.animation);
      if (!files.dir) this.watchDirs.add(dir);
      lines.push(`Files in ${dir}: ${written.frames} PNG ${written.frames === 1 ? "frame" : "frames"} (each frame that differs from the one before), watch.json with every frame's time, file, change and actions${written.animation ? ", and watch.webp, an animation in real time" : ""}.` +
        (files.dir ? "" : " The folder is removed when the computer session closes."));
    } catch (error) { lines.push(`The frames were not written to ${dir}: ${error instanceof Error ? error.message : error}`); }
    lines.push("Read the sequence with a frames: view for other frames.");
    const result = this.result(frames.length ? "observed" : "refused", lines.join("\n"), undefined,
      { sequence: sequenceMetadata(sequence), ...(rendered ? { rendered_frames: rendered } : {}),
        watch: { sequence_id: id, watching: watch.watching, running: false, marks: watch.marks, changed_frames: distinct, ...(written ? { files: written } : {}) } });
    result.content.push(...content);
    return result;
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
          return { ...d, display_ref: entry.ref, source_identity: this.domained(sourceIdentity({ session_id: this.sessionId, display_ref: entry.ref, display_id: d.display_id, topology_id: topology }, d.display_id)) };
        });
        for (const ref of this.displayEntries.keys()) if (!current.has(ref)) this.displayEntries.delete(ref);
        return this.result("listed", "Native connected Windows displays. Read a returned display address for its pixels. Image pixels start at zero; bounds are host-global. No input authority.",
          { platform: "windows", topology_id: topology, displays: addressed });
      } catch (error) {
        this.displayEntries.clear();
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) return this.result("refused", "Cancelled during display discovery; metadata withheld.");
        return this.result("refused", `Native display discovery failed. ${error instanceof Error ? error.message : error}`);
      }
    });
  }

  /**
   * Read the controlled machine's clipboard in YOLO: its formats, text and, when asked, its image as PNG.
   * The clipboard is shared with the user, so it is read only on this explicit call.
   */
  clipboardRead(image: boolean, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (this.getMode() !== "yolo") return this.result("refused", "Safe mode forbids clipboard access: it is shared with the user's own apps. Only the user can select YOLO with /computer-mode.");
      if (signal?.aborted) return this.result("refused", "Cancelled before reading the clipboard.");
      try {
        if (image && !this.host) return this.result("refused", "Clipboard images need the machine host, which this desktop does not have.");
        const state = await this.state("clipboard_read", { include_text: true }, signal);
        const png = image ? await this.host!.clipboardImage() : undefined;
        const text = typeof state.text === "string" ? state.text : undefined;
        return this.result("observed", `Clipboard formats: ${JSON.stringify(state.types ?? state.available_types ?? [])}.${text !== undefined ? `\nText (${text.length} characters):\n${text}` : " No text."}${image ? png ? " Image attached." : " No image." : ""}`,
          { types: state.types ?? state.available_types, ...(text !== undefined ? { text } : {}) }, {}, png ? [{ type: "image", mimeType: "image/png", data: png.toString("base64") }] : []);
      } catch (error) { return this.result("refused", `Clipboard read failed: ${error instanceof Error ? error.message : error}`); }
    });
  }

  /**
   * Record the main display to video in YOLO, into this session's folder, for at most `seconds`.
   * The driver captures with ffmpeg; recording stops on record_stop, at the limit or when the session closes.
   */
  recordStart(seconds: number, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (this.getMode() !== "yolo") return this.result("refused", "Safe mode forbids display recording. Only the user can select YOLO with /computer-mode.");
      if (!this.host) return this.result("refused", "Recording needs the session folder, which this desktop does not have.");
      if (this.recording) return this.result("refused", "A recording is already running; stop it first.");
      const folder = await this.host.files();
      const native = await this.driver.call("start_recording", { output_dir: folder.windows, record_video: true, include_accessibility_tree: false }, signal);
      const state = native.structuredContent ?? {};
      if (native.isError || state.video_active !== true) {
        await this.driver.call("stop_recording", {}).catch(() => undefined);
        return this.result("refused", `Recording did not start${state.last_error ? `: ${state.last_error}` : ""}. Video needs ffmpeg on that machine (for example winget install Gyan.FFmpeg).`, state);
      }
      const timer = setTimeout(() => { void this.recordStop(); }, seconds * 1000);
      this.recording = { timer, started: Date.now() };
      return this.result("delivered", `Recording the main display for up to ${seconds} s. Stop it earlier with computer_record video_stop to fetch the video.`, state);
    });
  }

  /** Record the machine's playback audio (YOLO) into the session folder as audio-<n>.wav. */
  recordAudio(seconds: number): Promise<ComputerResult> {
    return this.queue(async () => {
      if (this.getMode() !== "yolo") return this.result("refused", "Safe mode forbids audio recording: it can capture the user's calls and media. Only the user can select YOLO with /computer-mode.");
      if (!this.host) return this.result("refused", "Audio recording needs the session folder, which this desktop does not have.");
      try {
        const name = await this.host.recordAudio(seconds, `audio-${++this.audioClips}.wav`);
        return this.result("delivered", `Recorded ${seconds} s of the playback audio as ${name} in the session folder.`, { name });
      } catch (error) { return this.result("refused", `Audio not recorded: ${error instanceof Error ? error.message : error}`); }
    });
  }

  /** Stop the running recording; the video stays in the session folder as recording-<n>.mp4. */
  recordStop(): Promise<ComputerResult> {
    return this.queue(async () => {
      const current = this.recording;
      if (!current || !this.host) return this.result("refused", "No recording is running, or it already stopped at its limit; list the session folder with computer_files to see saved videos.");
      clearTimeout(current.timer);
      this.recording = undefined;
      const native = await this.driver.call("stop_recording", {});
      const name = `recording-${++this.recordings}.mp4`;
      try { await this.host.rename("recording.mp4", name); }
      catch (error) { return this.result("unknown", `Recording stopped, but its video was not found: ${error instanceof Error ? error.message : error}`, native.structuredContent); }
      return this.result("delivered", `Recorded ${Math.round((Date.now() - current.started) / 1000)} s of the main display as ${name} in the session folder.`, { ...native.structuredContent, name });
    });
  }

  /** Turn WebView2 remote debugging on or off for one app's next start (YOLO only); see MachineHost.webview2Debugging. */
  webview2Debugging(app: string, enabled: boolean): Promise<ComputerResult> {
    return this.queue(async () => {
      if (this.getMode() !== "yolo") return this.result("refused", "WebView2 debugging opens an app's pages to automation, so Safe mode refuses it. Only the user can select YOLO with /computer-mode.");
      if (!this.host) return this.result("refused", "This desktop has no Windows host for WebView2 settings.");
      try {
        const value = await this.host.webview2Debugging(app, enabled);
        return this.result("delivered", enabled
          ? `WebView2 debugging is on for ${app} (${value}). It applies when the app next starts, whoever starts it, and stays until turned off; restart the app, then attach its window with computer_open.`
          : `WebView2 debugging is off for ${app}. It applies when the app next starts.`, { operation: "webview2_debugging", app, enabled, value: value ?? null });
      } catch (error) { return this.result("refused", `Changing the WebView2 policy failed: ${error instanceof Error ? error.message : error}`); }
    });
  }
  /** Replace the controlled machine's clipboard in YOLO with text or an image file already on that machine. */
  clipboardWrite(value: { text: string } | { imagePath: string }, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (this.getMode() !== "yolo") return this.result("refused", "Safe mode forbids clipboard access: it is shared with the user's own apps. Only the user can select YOLO with /computer-mode.");
      if (signal?.aborted) return this.result("refused", "Cancelled before writing the clipboard.");
      try {
        const state = await this.state("clipboard_write", "text" in value ? { text: value.text } : { image_path: value.imagePath }, signal);
        return this.result("delivered", `Clipboard replaced with ${"text" in value ? `text (${value.text.length} characters)` : "an image"}. Paste with ctrl+v in the target window.`, state);
      } catch (error) { return this.result("refused", `Clipboard write failed: ${error instanceof Error ? error.message : error}`); }
    });
  }

  /** Change a discovered display's resolution in YOLO. Closing the session restores the mode it replaced. */
  resizeDisplay(display: string, mode: DisplayMode, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (this.getMode() !== "yolo") return this.result("refused", "Safe mode forbids display changes. Only the user can select YOLO with /computer-mode.");
      if (!this.host) return this.result("refused", "Display resizing is not available for this desktop.");
      const entry = this.displayEntries.get(display);
      if (!entry) return this.result("refused", "Unknown or outdated display reference. Read the displays again.");
      if (signal?.aborted) return this.result("refused", "Cancelled before the display change.");
      let change;
      try { change = await this.host.displayModes.set(entry.native.monitor_handle, mode, signal); }
      catch (error) {
        // A cancelled or timed-out change may still have reached Windows.
        if (signal?.aborted) return this.result("unknown", "Cancelled during the display change; the resolution may have changed. Read the displays again.");
        return this.result("refused", `Display not changed. ${error instanceof Error ? error.message : error}`);
      }
      if (!this.replacedModes.has(change.device)) this.replacedModes.set(change.device, change.previous);
      const original = this.replacedModes.get(change.device)!;
      if (original.width === change.current.width && original.height === change.current.height) this.replacedModes.delete(change.device);
      // New geometry: display references and window coordinates from before no longer hold.
      this.displayEntries.clear(); this.displayOverview = undefined;
      return this.result("delivered", `Display ${change.device} is now ${change.current.width}x${change.current.height} (was ${change.previous.width}x${change.previous.height}). ` +
        `Read the displays and windows again before acting; old display references are gone. Closing the computer session restores ${original.width}x${original.height}.`);
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
  observeDisplay(display: string, signal?: AbortSignal, zoom?: DetailRequest, size?: { maxLongEdge?: number; scale?: number }): Promise<ComputerResult> {
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
        const settings = { ...this.overviewSettings(), ...size }; const cap = nativeImageCap(settings);
        const native = await this.readDisplay(entry, cap, signal);
        if (this.getMode() !== "yolo") return denied();
        if (signal?.aborted) return this.result("refused", "Cancelled during display capture; pixels withheld.");
        const state = native.structuredContent;
        if (native.isError || state?.status === "refused" || state?.effect === "refused") {
          if (entry) this.displayEntries.delete(entry.ref);
          // The native reason, such as a locked PC, tells the agent whether discovering again can help.
          const reason = native.content.filter(c => c.type === "text").map(c => c.text).join(" ").slice(0, 600);
          return this.result("refused", `CUA refused exact-display capture${reason ? `: ${reason}` : "."} No fallback.`);
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
      Object.assign(source, this.domained(sourceIdentity(source.identity, null, window.virtual_desktop, this.platform)));
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
  private async capture(entry: WindowEntry, signal?: AbortSignal, query?: string, options: UiCaptureOptions = {}, quiet = false): Promise<ComputerResult> {
    validateUiCapture(options);
    // A native capture keeps the page's DOM snapshot: reading changes nothing, so both stay current until input.
    entry.windowState = undefined;
    const granularity = options.granularity ?? "full";
    const hasUi = granularity !== "image"; const hasImage = granularity !== "ui";
    if (!hasUi && query !== undefined) return this.result("refused", "Image-only observation cannot query UI labels.");
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
    const elements = hasUi ? state.elements as { element_token?: unknown; frame?: unknown; label?: unknown; value?: unknown }[] : [];
    // The UI resource cuts each text at 1024 characters; keep longer texts privately for element:text reads.
    const texts = new Map<string, string>();
    if (ui) elements.filter(element => typeof element.element_token === "string").forEach((element, index) => {
      const full = [element.label, element.value].filter((item): item is string => typeof item === "string" && item.length > 1024);
      if (full.length && ui.elements[index]) texts.set(ui.elements[index].hint, full.join("\n").slice(0, ELEMENT_TEXT_LIMIT));
    });
    // Only an image the agent is shown sets the space of its points; successors and other quiet captures keep it.
    if (hasImage && !quiet && typeof state.screenshot_width === "number" && typeof state.screenshot_height === "number") entry.seen = { width: state.screenshot_width, height: state.screenshot_height };
    entry.observation = { id, ui, settings, ...(texts.size ? { texts } : {}),
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
    if (!hasImage) source.capabilities.detail = "unsupported";
    // Repeated verification samples do not flash the human frame on every walk.
    const highlight = quiet ? undefined : await notifyWindowObserver(this.observer, entry.target, entry.identity, state.window_bounds, signal);
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
      entry.frame = { observation_id: id, png: Buffer.from(raw.data, "base64"), size: { maxLongEdge: settings.maxLongEdge, scale: settings.scale } };
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
    return this.result("observed", message, state, { ...extra, ...(ui ? { ui: structuredClone(ui) } : {}),
      agent_image: { ...metadata, ...(rendered.image !== raw ? { route: "cua_native_ui_hints" } : {}), annotation: rendered.annotation, image_id: id } }, [rendered.image]);
  }

  /** Resolve a permitted window bound to a browser this session opened through Playwright. */
  private async webEntry(ref: string, signal?: AbortSignal): Promise<WindowEntry | ComputerResult> {
    let entry: WindowEntry | undefined;
    try { entry = await this.current(ref, signal); }
    catch (error) { return this.result("refused", `Window lifetime check failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!entry) return this.entries.has(ref) ? this.denied(ref) : this.result("refused", "Unknown or closed window. Discover again.");
    if (!entry.web) return this.result("refused", "DOM is available only in browsers opened or attached with computer_open (attaching is YOLO). Use image/ui/full Reads for other windows.",
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
      // A DOM snapshot keeps the window's native capture: reading changes nothing, so both stay current until input.
      entry.dom = undefined; entry.windowState = undefined;
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
  webImage(ref: string, id: string, kind: "page" | "crop" | "highlight", target?: WebTarget, signal?: AbortSignal, css = false): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = await this.webEntry(ref, signal);
      if (!("ref" in entry)) return entry;
      if (entry.dom?.id !== id) return this.result("refused", "This DOM observation is no longer current. Read the window with dom again.", undefined, this.addressed(entry));
      try {
        const shot = await entry.web!.request<{ url: string; title: string; png: string; box?: unknown }>("screenshot",
          { ...(target ? { target } : {}), highlight: kind === "highlight", ...(css ? { css } : {}) }, signal);
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

  /**
   * Perform one page action in the active tab of a browser window without a DOM observation: navigation, tabs,
   * dialogs, files and page code. Refs in a target resolve against the page's latest snapshot. The result carries
   * the page's next snapshot as a new observation.
   */
  actPage(ref: string, action: WebAction, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = await this.webEntry(ref, signal);
      if (!("ref" in entry)) return entry;
      if (!this.allowed(entry)) return this.denied(ref);
      entry.dom = undefined; entry.windowState = undefined; entry.observation = undefined; entry.detail = undefined;
      try {
        const observed = this.webObservation(entry, await entry.web!.page("act", action, signal));
        return this.result("delivered", `Playwright performed ${action.action}. Check the fresh snapshot below for the page's response.`,
          undefined, { ...this.addressed(entry), observation_id: observed.id, dom: observed.page });
      } catch (error) { return this.webFailure(entry, error, true); }
    });
  }

  /** Whether this window is a browser this session opened or attached, whose pages Playwright drives. */
  isBrowserWindow(ref: string): boolean {
    return this.entries.get(ref)?.web !== undefined;
  }

  /** Validate a wait_for/verify command for this window: owned browsers take Playwright targets and page checks. */
  waitSpec(ref: string, command: Record<string, unknown>): WaitSpec {
    return validateWait(command, this.entries.get(ref)?.web !== undefined);
  }

  /**
   * Sample conditions until all hold for `stable` consecutive samples, or until `timeout_ms` passes.
   * Native windows take a fresh bounded UI walk per sample; owned browsers ask Playwright. Nothing is
   * dispatched. The last sample becomes the window's current observation with fresh input authority.
   */
  waitFor(ref: string, spec: WaitSpec, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const started = performance.now();
      let entry: WindowEntry | undefined;
      try { entry = await this.current(ref, signal); }
      catch (error) { return this.result("refused", `Window lifetime check failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (!entry) return this.entries.has(ref) ? this.denied(ref) : this.result("refused", "Unknown or closed window. Discover again.");
      if (!this.allowed(entry)) return this.denied(entry.ref);
      let samples = 0, stable = 0, results: ConditionResult[] = [], last: ComputerResult | undefined;
      entry.dom = undefined; entry.windowState = undefined;
      const finish = (verdict: WaitResult["verdict"], timedOut: boolean, final: ComputerResult | undefined, why?: string): ComputerResult => {
        const verification = { verdict, conditions: results, samples, elapsed_ms: Math.round(performance.now() - started), timed_out: timedOut,
          ...(why ? { reason: why } : {}), spec };
        const message = `Verification ${verdict} after ${samples} sample(s) in ${verification.elapsed_ms} ms${timedOut ? " (timed out)" : ""}.${why ? ` ${why}` : ""}`;
        const d = final?.details;
        return this.result("observed", message, undefined, { ...this.addressed(entry!), verification,
          ...(d?.observation_id ? { observation_id: d.observation_id } : {}), ...(d?.ui ? { ui: d.ui } : {}), ...(d?.dom ? { dom: d.dom } : {}) });
      };
      while (true) {
        if (signal?.aborted) return finish("unknown", false, last, "Cancelled; the last sample does not decide the conditions.");
        if (!this.allowed(entry)) return this.denied(entry.ref);
        if (entry.web) {
          try { results = await entry.web.request<ConditionResult[]>("check", { conditions: spec.conditions }, signal); }
          catch (error) { results = []; return finish("unknown", false, undefined, `Playwright could not sample the page: ${error instanceof Error ? error.message : String(error)}`); }
        } else {
          const sample = await this.capture(entry, signal, undefined, { granularity: "ui" }, true);
          if (sample.details.status !== "observed" || !sample.details.ui) {
            results = spec.conditions.map((_, index) => ({ index, verdict: "unknown" as const, reason: "No current UI sample." }));
            const why = sample.content.filter(block => block.type === "text").map(block => block.text).join("\n").split("\n{", 1)[0];
            return finish("unknown", false, undefined, why);
          }
          last = sample;
          results = evaluateNative(sample.details.ui, spec.conditions, entry.observation?.texts);
        }
        samples++;
        const verdict = combine(results);
        stable = verdict === "satisfied" ? stable + 1 : 0;
        if (stable >= spec.stable) break;
        if (performance.now() - started + spec.interval_ms > spec.timeout_ms) {
          if (entry.web) last = await this.webFinal(entry, signal);
          return finish(verdict, spec.timeout_ms > 0, last);
        }
        try { await delay(spec.interval_ms, undefined, { signal }); } catch { /* checked at the top of the loop */ }
      }
      if (entry.web) last = await this.webFinal(entry, signal);
      return finish("satisfied", false, last);
    });
  }

  /**
   * The complete text of one element in the current native observation, without another walk. Texts longer
   * than the walk's 1024-character cut come from the same capture, up to 200,000 characters.
   */
  elementText(ref: string, id: string, hint: string): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = this.entries.get(ref);
      if (!entry) return this.result("refused", "Unknown or closed window. Discover again.");
      if (!this.allowed(entry)) return this.denied(entry.ref);
      const observed = entry.observation;
      if (!observed || observed.id !== id || !observed.ui) return this.result("refused", "This observation is no longer current or has no UI. Read the window again.", undefined, this.addressed(entry));
      let element;
      try { element = resolveUi(observed.ui, hint); }
      catch (error) { return this.result("refused", (error as Error).message, undefined, this.addressed(entry)); }
      const text = observed.texts?.get(hint) ?? [element.name, element.value].filter(item => item).join("\n");
      const cut = text.length >= ELEMENT_TEXT_LIMIT;
      return this.result("observed", `Element ${hint} text from this observation: ${text.length} characters${cut ? ", cut at the 200,000-character limit" : ""}. Page it with offset/limit.`,
        undefined, { ...this.addressed(entry), observation_id: id, element_text: { hint, role: element.role, name: element.name, text, cut } });
    });
  }

  /** The window's latest unannotated capture with pixels, the baseline for comparing its pixels; undefined when none is kept. */
  windowFrame(ref: string): WindowFrame | undefined { return this.entries.get(ref)?.frame; }

  /**
   * A full-resolution capture of a window for input in one of its viewports: it becomes the window's current
   * observation. Quiet, like a successor, so points of the window's latest image keep their meaning.
   */
  observeFull(ref: string, signal?: AbortSignal, granularity: "image" | "full" = "full"): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before observation.");
      try {
        const entry = await this.current(ref, signal);
        if (!entry) return this.entries.has(ref) ? this.denied(ref) : this.result("refused", "Unknown or closed window_ref. Discover again.");
        if (!this.allowed(entry)) return this.denied(entry.ref);
        return await this.capture(entry, signal, undefined, { granularity, maxLongEdge: FULL_RESOLUTION, scale: 1, hints: false }, true);
      } catch (error) { return this.failed(error, false); }
    });
  }

  /**
   * A window's pixels at full resolution for a viewport, without UI. Only looks: the window's observations, its pixel
   * baseline and the size of the image the agent last saw stay as they are.
   */
  windowPixels(ref: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before capture.");
      try {
        const entry = await this.current(ref, signal);
        if (!entry) return this.entries.has(ref) ? this.denied(ref) : this.result("refused", "Unknown or closed window_ref. Discover again.");
        if (!this.allowed(entry)) return this.denied(entry.ref);
        const native = await this.driver.call("get_window_state", { ...entry.target, include_accessibility_tree: false, max_image_dimension: FULL_RESOLUTION }, signal);
        if (!this.allowed(entry)) return this.denied(entry.ref);
        if (signal?.aborted) return this.result("refused", "Cancelled during capture; pixels withheld.");
        const state = native.structuredContent ?? {};
        if (native.isError || typeof state.screenshot_error === "string" && state.screenshot_error.trim())
          return this.result("refused", `Window screenshot unavailable${typeof state.screenshot_error === "string" ? `. Native reason: ${state.screenshot_error.trim().slice(0, 2000)}` : "."}`, undefined, this.addressed(entry, state.virtual_desktop));
        const images = native.content.filter(block => block.type === "image");
        const width = state.screenshot_width, height = state.screenshot_height;
        if (images.length !== 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) <= 0 || (height as number) <= 0)
          throw new Error("Driver returned no window image.");
        if (!await this.current(entry.ref, signal) || !this.allowed(entry)) return this.result("refused", "Window changed during capture. Discover again.");
        const highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, state.window_bounds, signal);
        return this.result("observed", `Full-resolution window pixels: ${width}x${height}.`, undefined,
          { ...this.addressed(entry, state.virtual_desktop), ...(highlight ? { highlight } : {}) }, images);
      } catch (error) { return this.failed(error, false); }
    });
  }

  /**
   * A fresh observation without the human frame, for successors: UI-only by default, or with
   * pixels at a given overview size so they compare with an earlier capture.
   */
  observeQuiet(ref: string, signal?: AbortSignal, options: UiCaptureOptions = { granularity: "ui" }): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before observation.");
      try {
        const entry = await this.current(ref, signal);
        if (!entry) return this.entries.has(ref) ? this.denied(ref) : this.result("refused", "Unknown or closed window_ref. Discover again.");
        if (!this.allowed(entry)) return this.denied(entry.ref);
        return await this.capture(entry, signal, undefined, options, true);
      } catch (error) { return this.failed(error, false); }
    });
  }

  /** A fresh DOM observation after browser verification, so later actions use current refs. */
  private async webFinal(entry: WindowEntry, signal?: AbortSignal): Promise<ComputerResult | undefined> {
    try {
      const observed = this.webObservation(entry, await entry.web!.page("snapshot", {}, signal));
      return this.result("observed", "", undefined, { observation_id: observed.id, dom: observed.page });
    } catch { return undefined; }
  }

  /** Acquire fresh one-use native state without pixels, a UI walk or ordinary-input authority. */
  observeWindowState(ref: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      try {
        const known = this.entries.get(ref);
        if (known && !this.allowed(known)) return this.denied(ref);
        // Sampling state only looks: the window's observations stay current; restore and management retire them.
        if (known) known.windowState = undefined;
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
          ? "Fresh native window state. computer_window changes it; desktop-frame units are not pointer coordinates."
          : "Fresh native window state. computer_window restore restores and activates this window.", state,
          { ...this.addressed(entry, kind === "management" ? (state.state as Record<string, unknown>).virtual_desktop : undefined), window_state_id: id, window_state_kind: kind });
      } catch (error) { return this.failed(error, false); }
    });
  }

  /**
   * Ask a window to close, like its close button: a browser this session opened closes with its disposable profile,
   * an attached one is detached first, other windows get WM_CLOSE. The app may keep the window open, for example to
   * ask about unsaved work; the result says whether it closed.
   */
  closeWindow(ref: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      try {
        const known = this.entries.get(ref);
        if (known && !this.allowed(known)) return this.denied(ref);
        const entry = await this.current(ref, signal);
        if (!entry) return this.result("refused", "Unknown or closed window. Discover again.");
        if (!this.allowed(entry)) return this.denied(ref);
        if (signal?.aborted) return this.result("refused", "Cancelled before closing the window.");
        const key = `${entry.target.pid}:${entry.target.window_id}`, browser = this.browsers.get(key);
        if (browser) {
          this.browsers.delete(key);
          entry.web = undefined; entry.dom = undefined;
          await browser.close().catch(() => undefined);
        }
        if (!this.host) {
          if (browser) { this.entries.delete(ref); return this.result("delivered", "The browser this session opened was closed.", undefined, this.addressed(entry)); }
          return this.result("refused", "Closing windows needs the machine's own Windows host, which this environment lacks. Click the window's close button, or Delete it with ?force=true when this session opened it.", undefined, this.addressed(entry));
        }
        const outcome = await this.host.closeWindow(entry.target.pid, entry.target.window_id, 5000);
        if (outcome === "refused") return this.result("refused", "Windows refused the close request; the window may belong to an elevated app. Click its close button instead.", undefined, this.addressed(entry));
        if (outcome === "open") return this.result("delivered", "Close was requested, but the window is still open after 5 s; it may be asking about unsaved work. Read it to see what it shows.", { closed: false }, this.addressed(entry));
        this.entries.delete(ref);
        return this.result("closed", "The window closed; its address expired.", { closed: true }, this.addressed(entry));
      } catch (error) { return this.failed(error, true); }
    });
  }
  /**
   * Force-close the process of a window this session opened, when every window of that process is session-owned.
   * Unsaved work in it is lost; a process that also shows other windows is never killed.
   */
  killOwned(ref: string, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      const entry = this.entries.get(ref);
      if (!entry) return this.result("refused", "Unknown or closed window. Discover again.");
      if (!entry.owned) return this.result("refused", "Only windows this session opened can be force-closed; close other windows through their own UI.");
      if (signal?.aborted) return this.result("refused", "Cancelled before closing the process.");
      try {
        const windows = (await this.state("list_windows", { pid: entry.target.pid }, signal)).windows as WindowTarget[] ?? [];
        const owned = new Set([...this.entries.values()].filter(e => e.owned).map(e => `${e.target.pid}:${e.target.window_id}`));
        const foreign = windows.filter(w => w.pid === entry.target.pid && !owned.has(`${w.pid}:${w.window_id}`));
        if (foreign.length) return this.result("refused", `Process ${entry.target.pid} also shows ${foreign.length} window(s) this session did not open; it was not killed. Close this window through its own UI.`);
        const native = await this.driver.call("kill_app", { pid: entry.target.pid }, signal);
        if (native.isError) return this.result("refused", `The process was not killed: ${native.content.filter(c => c.type === "text").map(c => c.text).join(" ")}`, native.structuredContent);
        for (const [key, other] of this.entries) if (other.target.pid === entry.target.pid) this.entries.delete(key);
        return this.result("delivered", `Process ${entry.target.pid} was force-closed; unsaved work in it is lost and its window addresses expired.`, native.structuredContent);
      } catch (error) { return this.failed(error, true); }
    });
  }

  /** The native target of a known window, read before work that may forget the window. */
  windowTarget(ref: string): WindowTarget | undefined { return this.entries.get(ref)?.target; }

  /** Whether a window still responds, with its process's memory and CPU; undefined when unknown or not measurable here. */
  processHealth(target: WindowTarget | undefined): Promise<ProcessHealth | undefined> {
    return target === undefined || !this.host ? Promise.resolve(undefined) : this.host.processHealth(target.pid, target.window_id).catch(() => undefined);
  }

  /** The unannotated overview pixels of a window observation, for text recognition in its own coordinates. */
  observationImage(ref: string, id: string): Content | undefined {
    const observed = this.entries.get(ref)?.observation;
    return observed?.id === id && !observed.pixelsOnly ? observed.rawImage : undefined;
  }

  /**
   * Icons and text areas that Cua perception (OmniParser icons, PP-OCR text) finds in a current window observation's
   * capture, with boxes in its overview pixels. Needs the perception extension installed on that machine.
   */
  visualRegions(ref: string, id: string, signal?: AbortSignal): Promise<VisualRegion[]> {
    return this.queue(async () => {
      const observed = this.entries.get(ref)?.observation;
      if (observed?.id !== id || !observed.captureId) throw new Error("This observation's native capture is no longer current. Read the window with regions again.");
      const native = await this.driver.call("parse_visual_regions", { capture_id: observed.captureId, options: { max_regions: 300 } }, signal);
      if (native.isError) throw new Error((native.content.filter(c => c.type === "text").map(c => c.text).join(" ") || "parse_visual_regions failed")
        + " The regions view needs the Cua perception extension on this machine; if it is missing, ask the user before installing it "
        + "(about 420 MB) and ask them to run /computer-setup perception.");
      const parsed = native.structuredContent as { capture: { screenshot: { width: number } }; regions: {
        kind: "icon" | "text"; bounds: { x: number; y: number; width: number; height: number }; text?: string | null; label?: string | null; confidence: number }[] };
      const scale = (observed.width ?? parsed.capture.screenshot.width) / parsed.capture.screenshot.width;
      const at = (value: number) => Math.round(value * scale);
      return parsed.regions.map(region => ({ kind: region.kind, x: at(region.bounds.x), y: at(region.bounds.y), width: at(region.bounds.width), height: at(region.bounds.height),
        // OmniParser's detector has one class; its "icon-class-0" label names nothing.
        ...(region.text ? { text: region.text } : {}), ...(region.label && !/^icon-class-\d+$/.test(region.label) ? { label: region.label } : {}), confidence: Math.round(region.confidence * 100) / 100 }));
    });
  }

  /** Recognise text with Windows OCR on this desktop's machine; boxes are in the given image's pixels, a region only reads that part. */
  async recognizeText(image: Content, region?: ScreenRect, signal?: AbortSignal): Promise<TextLine[]> {
    if (!this.host) throw new Error("Text recognition is not available for this desktop.");
    if (image.type !== "image") throw new Error("Text recognition needs an image.");
    if (signal?.aborted) throw new Error("Cancelled before text recognition.");
    return this.host.ocr(Buffer.from(image.data, "base64"), region);
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
    if (!observed.width && ["highlight", "scope", "crop"].includes(request.operation))
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
    if (["highlight", "scope"].includes(request.operation)) {
      if (!observed.rawImage) return this.result("refused", "Snapshot image was evicted. Read a new overview; its hints will change.");
      const rendered = await annotateUi(observed.rawImage, ui, observed.width, observed.height,
        observed.settings.hints ?? true, request.operation === "highlight" ? request.hint : undefined, observed.ui.elements,
        { options: observed.settings.guides, action: observed.actionMark });
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
      if (observed.pixelsOnly) {
        const change = await this.observationChange(entry, observed, signal).catch((error: unknown) => `the window state could not be read (${error instanceof Error ? error.message : error})`);
        if (change) { entry.observation = undefined; return this.result("refused", `Observation expired: ${change}. Read the window again; no input was dispatched.`); }
      }
      const { window_ref: _ref, observation_id: _id, delivery_mode, uia_only, ...command } = action;
      const batch = command.action === "sequence";
      let commands: InputStep[];
      try {
        if (delivery_mode !== undefined && !["background", "foreground"].includes(delivery_mode)) throw new Error("Unsupported delivery mode.");
        if (uia_only !== undefined && (uia_only !== true || delivery_mode === "foreground" || batch || !["click", "scroll"].includes(String(command.action))))
          throw new Error("uia_only takes one background click or scroll on an element.");
        if (batch) {
          if (Object.keys(command).some(key => !["action", "sequence"].includes(key)) || !Array.isArray(command.sequence) || command.sequence.length < 1 || command.sequence.length > SEQUENCE_STEPS)
            throw new Error(`A sequence needs 1..${SEQUENCE_STEPS} steps and no conflicting top-level action fields.`);
          commands = command.sequence;
        } else commands = [command];
        commands = commands.map(step => {
          const { hint, ...nativeStep } = step;
          if (hint !== undefined) {
            if (typeof hint !== "string" || step.element_token !== undefined || step.x !== undefined || step.y !== undefined)
              throw Error("Use exactly one current hint or native token/pixel target.");
            if (!observed.ui) throw Error("Image-only observation has no current hints.");
            if (observed.pixelsOnly) throw Error("UI hints of this observation expired with the previous input. Use pixel coordinates, or Read the window again.");
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
            if (!observed.captureId) throw Error("Coordinate scroll needs this overview's native capture. Observe again.");
          }
          if (isPointerMove(nativeStep.action)) {
            if (!this.driver.nativePointer) throw Error("Pointer movement requires the explicitly selected native pointer runtime. No input was dispatched.");
            if (nativeStep.element_token ? !observed.frames.has(nativeStep.element_token) : !observed.captureId)
              throw Error("Pointer movement needs a current token with proven geometry or this overview's native capture. Observe again.");
          }
          if (isSemanticAction(nativeStep.action)) {
            if (!this.driver.semanticActions) throw Error("Semantic actions require the explicitly selected qualified Windows semantic runtime. No input was dispatched.");
            if (delivery_mode === "foreground") throw Error("Semantic actions use accessibility only: no foreground delivery.");
          }
          return nativeStep;
        });
        if (observed.pixelsOnly && commands.some(step => step.element_token !== undefined || isSemanticAction(step.action)))
          throw new Error("UI tokens of this observation expired with the previous input. Use pixel coordinates, or Read the window again.");
        if (this.driver.captureBoundDrag && !observed.captureId && !observed.pixelsOnly && commands.some(step => step.action === "drag" && step.via === undefined))
          throw new Error("Straight drag requires this overview's native capture. Observe again; no batch input was dispatched.");
        if (commands.some(step => step.action === "hold") && !this.driver.heldKeys)
          throw new Error("Key holds require the explicitly selected qualified Windows key-hold runtime. No input was dispatched.");
        if (commands.some(step => step.via !== undefined) && !this.driver.heldPaths)
          throw new Error("Continuous paths require the explicitly selected qualified Windows fork. No batch input was dispatched.");
        if (batch && commands.reduce((ms, step) => ms + requestedInputTime(step), 0) > SEQUENCE_REQUESTED_MS)
          throw new Error(`A sequence exceeds ${SEQUENCE_REQUESTED_MS / 60000} minutes of requested waits/typing/drags.`);
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
        let capture = observed.captureId;
        for (const [index, step] of commands.entries()) {
          if (signal?.aborted) return finish(this.result("refused", "Cancelled."), "Cancelled before the next dispatch.");
          if (!this.allowed(entry)) return finish(this.denied(entry.ref), "Permission revoked before the next dispatch.");
          if (batch && performance.now() - started >= SEQUENCE_ELAPSED_MS) return finish(this.result("refused", "Sequence time budget reached."), `${SEQUENCE_ELAPSED_MS / 60000} min elapsed budget reached; no more steps dispatched.`);
          if (step.wait_ms) await delay(step.wait_ms, undefined, { signal });
          const current = await this.current(entry.ref, signal);
          if (!this.allowed(entry)) return finish(this.denied(entry.ref), "Permission revoked before dispatch.");
          if (!current) return finish(this.result("refused", "Window closed or its native handle was reused. Discover again."), "Window lifetime changed.");
          if (signal?.aborted) return finish(this.result("refused", "Cancelled."), "Cancelled before dispatch.");
          // The native capture is single-use: the first step that binds to it spends it, later pixel steps use the window's current mapping.
          const { name, args } = nativeInput(step, entry.target, delivery_mode ?? "background", capture, this.driver.captureBoundDrag, uia_only);
          if (args.capture_id !== undefined) capture = undefined;
          // AX bounds are native. Only native click receipts establish an exact pixel action mark.
          const mark = { kind: "action" as const, region: step.element_token ? observed.frames.get(step.element_token) : undefined };
          let highlight = await notifyWindowObserver(this.observer, entry.target, entry.identity, observed.bounds, signal, mark);
          if (signal?.aborted) return finish(this.result("refused", "Cancelled during action mark; input was not dispatched."), "Cancelled during action mark.");
          if (!this.allowed(entry)) return finish(this.denied(entry.ref), "Permission revoked during action mark.");
          if (batch && performance.now() - started >= SEQUENCE_ELAPSED_MS) return finish(this.result("refused", "Sequence time budget reached."), `${SEQUENCE_ELAPSED_MS / 60000} min elapsed budget reached during admission; no more steps dispatched.`);
          // Input may change the page, so the window's DOM snapshot retires with its native capture.
          entry.observation = undefined; entry.detail = undefined; entry.dom = undefined;
          const pointerAction = isPointerMove(step.action) || isCoordinateScroll(step) || ["click", "right_click", "double_click", "drag"].includes(step.action) || (step.action === "hold" && !!step.actions?.length);
          if (pointerAction) entry.lastAction = { reason: "Pointer outcome is not yet confirmed." };
          const requested = { ...step, ...(step.text !== undefined ? { text_length: step.text.length } : {}),
            ...(step.via ? { via_points: step.via.length } : {}), ...(step.actions ? { actions: step.actions.map(pointer => { const { via, ...compact } = pointer; return { ...compact, ...(via ? { via_points: via.length } : {}) }; }) } : {}) };
          delete requested.text; delete requested.element_token;
          delete requested.via;
          const row: Record<string, unknown> = { index, action: step.action, native_tool: name, requested,
            requested_wait_ms: step.wait_ms ?? 0, dispatch_ms: performance.now() - started, status: "unknown" };
          trace.steps.push(row); trace.attempted++; inFlight = true;
          // A sequence stops between steps: its current step finishes and releases its own keys and buttons,
          // and the driver connection survives the cancellation. A single action stays cancellable in flight.
          const nativeSignal = batch ? undefined : signal;
          const native = await this.driver.call(name, args, nativeSignal);
          row.completion_ms = performance.now() - started;
          if (!this.allowed(entry) || (!batch && signal?.aborted)) return finish(this.result("unknown",
            "Input was dispatched before permission was revoked or cancellation. Outcome withheld; native input may still have completed. Do not replay blindly."),
            "In-flight outcome withheld after revocation/cancellation.");
          const state = native.structuredContent ?? {};
          const nativeMessage = native.content.filter(c => c.type === "text").map(c => c.text).join("\n");
          // Foreground input checks for recent physical input before sending anything (CUA_HUMAN_IDLE_MS).
          const takeover = /human_takeover:/.test(nativeMessage) && (native.isError || state.effect === "refused");
          const refused = takeover || state.status === "refused" || state.effect === "refused" || ["invalid_action_target", "invalid_arguments", "stale_element_token",
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
          if (!this.allowed(entry) || (!batch && signal?.aborted)) {
            entry.lastAction = { reason: "In-flight pointer outcome was withheld after revocation or cancellation." };
            return finish(this.result("unknown", "Input was dispatched before revocation or cancellation. Do not replay blindly."), "In-flight outcome withheld after input.");
          }
          const result = this.result(status, takeover ? `Foreground input paused because the human is using the computer: ${nativeMessage.slice(nativeMessage.indexOf("human_takeover:") + 16)}` : `Driver returned ${status} for ${name} (requested: ${delivery_mode ?? "background"}). ${isSemanticAction(step.action) ? "A UIA receipt is not app or focus verification. " : ""}Observe again to verify application state.${step.action === "hold" && typeof state.summary === "string" ? `\n${state.summary}` : ""}`,
            { ...state, ...(step.element_token || pointerAction ? { coordinate_grounding: { input_space: step.element_token ? "native_element_token" : "window_image_pixels", transform: "cua_native_once",
              overview: { width: observed.width, height: observed.height }, ...(step.x !== undefined ? { requested: { x: step.x, y: step.y } } : {}),
              resolved_native_screen: resolvedPoint ?? null, native_target_mark: isSemanticAction(step.action) ? null : entry.lastAction ?? null } } : {}),
            ...(native.isError || !native.structuredContent ? {
              native_message: nativeMessage,
            } : {}) }, { ...this.addressed(entry), action_capability: capability, ...(highlight ? { highlight } : {}) });
          if (!batch || status !== "delivered" || index === commands.length - 1) {
            // Pixel-only input keeps the overview usable: the next call checks the window size instead of capturing again.
            if (status === "delivered" && this.driver.windowManagement && observed.bounds && commands.every(item => item.element_token === undefined && !isSemanticAction(item.action)))
              entry.observation = { ...observed, captureId: undefined, pixelsOnly: true };
            return finish(result, status === "delivered" ? "" : `Stopped after native ${status}; later steps were not dispatched.`);
          }
        }
        throw new Error("No complete input step.");
      } catch (error) {
        if (inFlight && trace.steps.length) trace.steps.at(-1)!.completion_ms = performance.now() - started;
        return finish(await this.failed(error, inFlight), inFlight ? "Transport/dispatch failed; current step is uncertain." : "Stopped before next dispatch.");
      }
    });
  }

  /** Why a kept pixel observation no longer matches its window, or undefined while it still does. Movement keeps window-local points valid. */
  private async observationChange(entry: WindowEntry, observed: Observation, signal?: AbortSignal): Promise<string | undefined> {
    const native = await this.driver.call("get_window_control_state", { pid: entry.target.pid, window_id: entry.target.window_id }, signal);
    const state = native.structuredContent?.state as { bounds?: ScreenRect; minimized?: boolean; visible?: boolean } | undefined;
    if (native.isError || !state?.bounds) return "the window state could not be read";
    if (state.minimized) return "the window was minimized";
    if (state.visible === false) return "the window is no longer visible";
    const before = observed.bounds!, now = state.bounds;
    if (now.width !== before.width || now.height !== before.height) return `the window was resized from ${before.width}x${before.height} to ${now.width}x${now.height}`;
    return undefined;
  }
  /** Whether a window still holds this observation for input. */
  holdsObservation(windowRef: string, id: string): boolean { return this.entries.get(windowRef)?.observation?.id === id; }
  /**
   * What typed input can use in a window now: its current observation (a DOM snapshot of a browser page, or a native
   * capture with its size and, until the first input spends them, its UI hints) and the size of its latest image,
   * which is the space of the agent's points.
   */
  inputView(ref: string): { dom?: string; native?: { id: string; width?: number; height?: number; ui?: UiResource; full: boolean }; seen?: { width: number; height: number } } {
    const entry = this.entries.get(ref), observed = entry?.observation;
    // A full-resolution observation's pixels are the window's own: viewport rectangles apply to them as they are.
    const full = !!observed && observed.width !== undefined && nativeImageCap(observed.settings) >= FULL_RESOLUTION;
    return { ...(entry?.dom ? { dom: entry.dom.id } : {}),
      ...(observed ? { native: { id: observed.id, width: observed.width, height: observed.height, full, ...(observed.ui && !observed.pixelsOnly ? { ui: observed.ui } : {}) } } : {}),
      ...(entry?.seen ? { seen: { ...entry.seen } } : {}) };
  }
  /** Whether this session issued a still-registered window reference. */
  hasWindow(ref: string): boolean { return this.entries.has(ref); }
  /** Whether this session issued a still-registered display reference. */
  hasDisplay(ref: string): boolean { return this.displayEntries.has(ref); }
  /** Whether this session captured the sequence and still retains it. */
  hasSequence(id: string): boolean { return this.sequences.get(id) !== undefined; }

  /** Close session-opened browsers (deleting their profiles), detach from attached ones and release the native runtime. Other windows/files are not closed or saved. */
  close(): Promise<ComputerResult> {
    return this.queue(async () => {
      const watches = [...this.watches.values()];
      this.watches.clear();
      for (const watch of watches) watch.stop.abort();
      await Promise.allSettled(watches.map(watch => watch.done));
      if (this.watcher && this.watcher !== this.driver) await this.watcher.close().catch(() => undefined);
      this.watcher = undefined;
      await Promise.allSettled([...this.watchDirs].map(dir => rm(dir, { recursive: true, force: true })));
      this.watchDirs.clear();
      this.entries.clear(); this.displayEntries.clear(); this.displayOverview = undefined; this.uiImages = []; this.sequences.clear();
      const browsers = [...this.browsers.values()];
      this.browsers.clear();
      const cleanup = await Promise.allSettled(browsers.map(browser => browser.close()));
      const modes = [...this.replacedModes];
      this.replacedModes.clear();
      const restored = await Promise.allSettled(modes.map(([device, mode]) => this.host!.displayModes.restore(device, mode)));
      if (this.recording) { clearTimeout(this.recording.timer); this.recording = undefined; }
      const files = await this.host?.removeFiles().then(() => true, () => false) ?? true;
      await this.driver.close();
      const failed = cleanup.filter(result => result.status === "rejected").length;
      const unrestored = modes.filter((_, i) => restored[i].status === "rejected").map(([device, mode]) => `${device} (${mode.width}x${mode.height})`);
      if (unrestored.length) return this.result("unknown", `Native runtime released, but restoring the display mode of ${unrestored.join(", ")} failed. Signing out of Windows also restores it.`);
      if (!files) return this.result("unknown", "Native runtime released, but removing the session's file folder failed.");
      if (failed) return this.result("unknown", `Native runtime released, but cleanup of ${failed} of ${browsers.length} Playwright browsers is unconfirmed.`);
      return this.result("closed", "Owned computer-use runtime and session-opened browsers released; attached browsers were detached and stay open. Other application documents were not closed or saved.");
    });
  }
}
