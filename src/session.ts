import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

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
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult>;
  identity(target: WindowTarget, create: boolean, signal?: AbortSignal): Promise<string | undefined>;
  close(): Promise<void>;
}
/** One action grounded in the latest observation of its session window reference. */
export interface Action {
  window_ref: string;
  observation_id: string;
  action: "type_text" | "set_value" | "click" | "select_all" | "key";
  delivery_mode?: "background" | "foreground";
  element_token?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
}
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
  };
  isError?: boolean;
}
interface Observation { id: string; tokens: Set<string>; width?: number; height?: number; captureId?: string }
interface WindowEntry { ref: string; target: WindowTarget; identity: string; owned: boolean; observation?: Observation }
interface App { name: string; launch_path?: string; bundle_id?: string; kind?: string }
const appName = (name: string) => name.trim().toLowerCase().replace(/^windows\s+/, "").replace(/\.exe$/, "");

/** Multi-window UI policy. Native work is queued; ownership and observations are not persisted across reloads. */
export class ComputerSession {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly entries = new Map<string, WindowEntry>();

  constructor(private readonly driver: Driver, private readonly getMode: () => ComputerMode = () => "yolo") {}

  private queue(work: () => Promise<ComputerResult>): Promise<ComputerResult> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private result(status: ComputerResult["details"]["status"], message: string,
    state?: Record<string, unknown>, extra: Partial<ComputerResult["details"]> = {}, images: Content[] = []): ComputerResult {
    const details = { ...extra, status, mode: this.getMode(), ...(state ? { state } : {}) };
    const json = JSON.stringify(details, null, 2);
    const visible = json.length > 24_000 ? json.slice(0, 24_000) + "\n[Text truncated; narrow the observation.]" : json;
    return { content: [{ type: "text", text: `${message}\n${visible}` }, ...images], details,
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
    return { target: entry.target, window_ref: entry.ref };
  }

  private async failed(error: unknown, dispatched: boolean): Promise<ComputerResult> {
    this.entries.clear();
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
          windows.push({ ...native, ...(entry ? { window_ref: entry.ref, owned: entry.owned } : { unavailable: "Cannot establish window lifetime identity." }) });
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

  private async capture(entry: WindowEntry, signal?: AbortSignal, query?: string): Promise<ComputerResult> {
    if (!this.allowed(entry)) return this.denied(entry.ref);
    entry.observation = undefined;
    const current = await this.current(entry.ref, signal);
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (!current) return this.result("refused", "Window closed or its native handle was reused. Discover again.");
    const native = await this.driver.call("get_window_state", {
      ...entry.target, max_elements: 200, max_depth: 15, timeout_ms: 5000,
      max_image_dimension: 1280, ...(query ? { query } : {}),
    }, signal);
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (native.isError) return this.result("refused", "Driver refused observation.", native.structuredContent, this.addressed(entry));
    const state = native.structuredContent;
    if (!state || !Array.isArray(state.elements)) throw new Error("Driver returned no structured UI elements.");
    const images = native.content.filter(block => block.type === "image");
    if (!images.length) throw new Error("Driver returned no grounding screenshot.");
    if (!this.allowed(entry)) return this.denied(entry.ref);
    if (!await this.current(entry.ref, signal)) return this.result("refused", "Window changed during observation. Discover again.");
    if (!this.allowed(entry)) return this.denied(entry.ref);
    const id = randomUUID();
    entry.observation = { id, width: typeof state.screenshot_width === "number" ? state.screenshot_width : undefined,
      height: typeof state.screenshot_height === "number" ? state.screenshot_height : undefined,
      tokens: new Set(state.elements.map(element => (element as { element_token?: unknown }).element_token)
        .filter((token): token is string => typeof token === "string")),
      captureId: typeof state.capture_id === "string" ? state.capture_id : undefined };
    return this.result("observed", "Fresh window observation. Use observation_id for one action, then read again.",
      state, { ...this.addressed(entry), observation_id: id }, images);
  }

  /** Read fresh UI state and a screenshot for an existing session reference. Only this window's earlier observation expires. */
  observe(ref: string, signal?: AbortSignal, query?: string): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before observation.");
      try {
        const known = this.entries.get(ref);
        if (known && !this.allowed(known)) return this.denied(ref);
        const entry = await this.current(ref, signal);
        if (known && !this.allowed(known)) return this.denied(ref);
        return entry ? await this.capture(entry, signal, query) : this.result("refused", "Unknown or closed window_ref. Discover again.");
      } catch (error) { return this.failed(error, false); }
    });
  }

  /** Consume one observation before native input. No automatic replay or rollback. */
  act(action: Action, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before action dispatch.");
      const entry = this.entries.get(action.window_ref);
      if (entry && !this.allowed(entry)) return this.denied(entry.ref);
      const observed = entry?.observation;
      if (!entry || !observed || action.observation_id !== observed.id)
        return this.result("refused", "Stale or missing observation_id/window_ref. Observe again.");
      const pixel = action.x !== undefined || action.y !== undefined;
      if (action.element_token && !observed.tokens.has(action.element_token))
        return this.result("refused", "Element token is not in this window's current observation.");
      if (pixel && (action.element_token || !Number.isFinite(action.x) || !Number.isFinite(action.y)
        || action.x! < 0 || action.y! < 0 || !observed.width || !observed.height
        || action.x! >= observed.width || action.y! >= observed.height))
        return this.result("refused", "Use an observed element token or coordinates inside the current scoped screenshot.");
      if (["type_text", "set_value"].includes(action.action) && action.text === undefined)
        return this.result("refused", "This text action needs text.");
      if (action.action === "set_value" && !action.element_token)
        return this.result("refused", "set_value needs an observed element token.");
      if (action.action === "click" && !action.element_token && !pixel)
        return this.result("refused", "click needs an observed token or screenshot coordinates.");
      if (action.action === "key" && !["backspace", "delete", "left", "right", "home", "end", "return", "escape", "tab"].includes(action.key ?? ""))
        return this.result("refused", "Unsupported key.");
      let dispatched = false;
      try {
        const current = await this.current(entry.ref, signal);
        if (!this.allowed(entry)) return this.denied(entry.ref);
        if (!current) return this.result("refused", "Window closed or its native handle was reused. Discover again.");
        const nativeName = action.action === "select_all" ? "hotkey" : action.action === "key" ? "press_key" : action.action;
        const args: Record<string, unknown> = {
          delivery_mode: action.delivery_mode ?? "background",
          ...(action.action === "set_value" ? { ...entry.target } : { target: { kind: "window", ...entry.target } }),
          ...(action.element_token ? { element_token: action.element_token } : {}),
          ...(pixel ? { x: action.x, y: action.y } : {}),
          ...(action.action === "click" && observed.captureId && pixel ? { capture_id: observed.captureId } : {}),
          ...(action.action === "type_text" ? { text: action.text } : {}),
          ...(action.action === "set_value" ? { value: action.text } : {}),
          ...(action.action === "select_all" ? { keys: ["ctrl", "a"] } : {}),
          ...(action.action === "key" ? { key: action.key } : {}),
        };
        if (signal?.aborted) return this.result("refused", "Cancelled before action dispatch.");
        if (!this.allowed(entry)) return this.denied(entry.ref);
        entry.observation = undefined;
        dispatched = true;
        const native = await this.driver.call(nativeName, args, signal);
        if (!this.allowed(entry)) return this.result("unknown",
          "Input was dispatched before Safe was selected. Its outcome is withheld; Safe cannot undo in-flight input. Do not replay blindly.",
          undefined, { window_ref: entry.ref });
        const state = native.structuredContent ?? {};
        const refused = state.effect === "refused" || ["invalid_action_target", "invalid_arguments", "stale_element_token",
          "conflicting_element_target", "background_unavailable"].includes(String(state.code));
        const status = native.isError ? (refused ? "refused" : "unknown") : "delivered";
        return this.result(status, `Driver returned ${status} for ${nativeName} (requested: ${args.delivery_mode}). Observe again to verify application state.`,
          { ...state, ...(native.isError || !native.structuredContent ? {
            native_message: native.content.filter(c => c.type === "text").map(c => c.text).join("\n"),
          } : {}) }, this.addressed(entry));
      } catch (error) { return this.failed(error, dispatched); }
    });
  }

  /** Release owned runtime and invalidate references. Application windows and files are not closed or saved. */
  close(): Promise<ComputerResult> {
    return this.queue(async () => {
      this.entries.clear();
      await this.driver.close();
      return this.result("closed", "Owned computer-use runtime closed. Application windows were not closed.");
    });
  }
}
