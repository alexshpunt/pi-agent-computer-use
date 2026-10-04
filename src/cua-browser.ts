import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Content, Driver, DriverResult, WindowTarget } from "./session.ts";

/** Native CUA capture policy. The adapter derives a cap but never resizes pixels. */
export interface CuaImageSettings { maxLongEdge: number; scale: number; version: number }
/** Focused browser result; native window and page coordinates remain separate. */
export interface CuaBrowserResult {
  content: Content[];
  details: Record<string, unknown> & { status: "observed" | "acted" | "listed" | "closed" | "refused" | "unknown" };
  isError?: boolean;
}
interface Tab { tab_id: string; title: string; url: string; active: boolean }
interface Alias { ref: string; actions: string[]; hint: string; role: string; name: string; value?: string }
interface Owned { driver: Driver; session: string; target?: WindowTarget; identity?: string; targetId?: string; tabs: Tab[]; focused?: string }
interface ImageContext { kind: "window" | "zoom"; width: number; height: number; captureId?: string; page: string; bounds: string }
class Refused extends Error {}
class LostWindow extends Refused {}
class CleanupUnconfirmed extends Error {}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CUA returned invalid structured state.");
  return value as Record<string, unknown>;
};
const positive = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("CUA returned an invalid native dimension or identity.");
  return value as number;
};

/** Thin CUA lifecycle/alias adapter. No browser engine, page JavaScript or image transform. */
export class CuaBrowser {
  private owned?: Owned;
  private aliases = new Map<string, Alias>();
  private image?: ImageContext;
  private tail: Promise<unknown> = Promise.resolve();
  private offset = 0;
  private signal?: AbortSignal;
  private dispatched = false;
  private cleanupUnconfirmed = false;

  constructor(private readonly createDriver: () => Promise<Driver>,
    private readonly settings: () => CuaImageSettings = () => ({ maxLongEdge: 500, scale: 1, version: 0 })) {}

  /** Monotonic alias allocation can be persisted by the Pi registration layer. */
  get allocatedHints(): number { return this.offset; }
  /** Never reuse an alias already exposed on an earlier session branch. */
  restoreHints(offset: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid hint allocation checkpoint.");
    this.offset = Math.max(this.offset, offset);
  }

  /** Serialize focused work and distinguish refusal from uncertain dispatched input. */
  call(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaBrowserResult> {
    const result = this.tail.then(async () => {
      this.signal = signal; this.dispatched = false;
      try {
        if (signal?.aborted) throw new Refused("Cancelled before browser input.");
        switch (operation) {
          case "open": return await this.open(args);
          case "observe": return await this.observe(args);
          case "act": return await this.act(args);
          case "tabs": return await this.list();
          case "focus": return await this.focus(args);
          case "close": {
            await this.dispose();
            return this.result("closed", "Owned CUA browser session released.");
          }
          default: throw new Refused("Unsupported browser operation.");
        }
      } catch (error) {
        const refused = error instanceof Refused && !this.dispatched;
        let cleanup = "";
        if (!refused || error instanceof LostWindow) {
          try { await this.dispose(); }
          catch (failure) { cleanup = ` Cleanup is unconfirmed: ${String(failure)}`; }
        }
        const status = cleanup || error instanceof CleanupUnconfirmed || this.dispatched ? "unknown" : "refused";
        const message = error instanceof Error ? error.message : String(error);
        return this.result(status, `${message}${cleanup}${status === "unknown" ? " Input may have occurred; never replay it blindly." : ""}`);
      } finally { this.signal = undefined; }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private result(status: CuaBrowserResult["details"]["status"], text: string,
    extra: Record<string, unknown> = {}, images: Content[] = []): CuaBrowserResult {
    return { content: [{ type: "text", text }, ...images], details: { ...extra, status, text, ownership: "driver-owned isolated browser" },
      ...(["refused", "unknown"].includes(status) ? { isError: true } : {}) };
  }

  private async native(name: string, args: Record<string, unknown> = {}, acting = false): Promise<DriverResult> {
    const owned = this.owned;
    if (!owned) throw new Refused("No owned browser. Open a new isolated browser first.");
    if (this.signal?.aborted) {
      if (this.dispatched) throw new Error("Cancelled after browser input.");
      throw new Refused("Cancelled before native input.");
    }
    const previouslyDispatched = this.dispatched;
    if (acting) this.dispatched = true;
    const result = await owned.driver.call(name, { ...args, session: owned.session }, this.signal);
    const state = result.structuredContent ?? {};
    const refused = state.status === "refused" || state.effect === "refused";
    if (result.isError || refused) {
      const message = result.content.filter(b => b.type === "text").map(b => b.text).join("\n") || String(state.summary ?? "");
      const delivery = state.delivery as { delivered_count?: number } | undefined;
      if (acting && refused && !delivery?.delivered_count && state.raised !== true && state.restored !== true && (!state.effect || state.effect === "refused")) this.dispatched = previouslyDispatched;
      if (!this.dispatched) throw new Refused(message || "CUA refused the request.");
      throw new Error(message || "CUA input outcome is uncertain.");
    }
    return result;
  }

  private page(): Record<string, unknown> {
    if (!this.owned?.targetId || !this.owned.focused) throw new Refused("No focused CUA page.");
    return { target_id: this.owned.targetId, tab_id: this.owned.focused };
  }

  private async lifetime(): Promise<void> {
    const owned = this.owned;
    if (!owned?.target || !owned.identity) throw new Refused("No owned browser window.");
    if (await owned.driver.identity(owned.target, false, this.signal) !== owned.identity)
      throw new LostWindow("The owned browser window closed or its native handle changed.");
  }

  /** The user-approved capture posture may take keyboard focus, but only on this live owned window. */
  private async foreground(): Promise<Record<string, unknown>> {
    await this.lifetime();
    const target = this.owned!.target!;
    const state = object((await this.native("bring_to_front", { ...target }, true)).structuredContent);
    const hwnd = `0x${target.window_id.toString(16)}`;
    if (state.landed_on_target !== true || state.target_hwnd !== hwnd || state.now_fg_hwnd !== hwnd)
      throw new Error("CUA did not confirm foreground on the exact owned browser. No capture was made.");
    return { route: "cua_bring_to_front", keyboard_focus_may_change: true, native: state };
  }

  private async binding(): Promise<{ targetId: string; tabs: Tab[] }> {
    await this.lifetime();
    const state = object((await this.native("get_browser_state", { ...this.owned!.target })).structuredContent);
    if (state.binding_quality !== "exact" || state.mutation_allowed !== true || typeof state.target_id !== "string" || !Array.isArray(state.tabs))
      throw new LostWindow("CUA could not prove the exact owned browser binding.");
    const tabs = state.tabs.map(value => {
      const tab = object(value);
      if (typeof tab.tab_id !== "string" || typeof tab.active !== "boolean") throw new Error("CUA returned an invalid tab.");
      return { tab_id: tab.tab_id, title: String(tab.title ?? ""), url: String(tab.url ?? ""), active: tab.active };
    });
    return { targetId: state.target_id, tabs };
  }

  private async bind(): Promise<void> {
    const state = await this.binding();
    this.owned!.targetId = state.targetId;
    this.owned!.tabs = state.tabs;
  }

  private async requireFocused(): Promise<Tab> {
    const state = await this.binding();
    // Bind mode mints NEW opaque IDs every time. Never replace the IDs behind
    // existing aliases. Native semantic input validates the original target/tab.
    if (state.tabs.length !== 1 || !state.tabs[0].active) {
      this.aliases.clear(); this.image = undefined;
      throw new Refused("CUA window images require exactly one active tab. Close extra owned tabs yourself, then focus the remaining tab.");
    }
    return state.tabs[0];
  }

  private pageKey(tab: Tab): string { return JSON.stringify([tab.title, tab.url]); }
  private boundsKey(value: unknown): string {
    const bounds = object(value);
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(v => typeof v === "number" && Number.isFinite(v)))
      throw new Error("CUA returned no usable window geometry.");
    return JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height]);
  }
  private async checkImage(): Promise<void> {
    const image = this.image!;
    const page = await this.requireFocused();
    const state = object((await this.native("list_windows", { pid: this.owned!.target!.pid })).structuredContent);
    const window = Array.isArray(state.windows) ? state.windows.map(object).find(w => w.window_id === this.owned!.target!.window_id && w.pid === this.owned!.target!.pid) : undefined;
    if (!window || image.page !== this.pageKey(page) || image.bounds !== this.boundsKey(window.bounds)) {
      this.image = undefined;
      throw new Refused("The observed page or window geometry changed. Observe again before pixel input or zoom.");
    }
  }
  private url(value: unknown): string {
    if (typeof value !== "string") throw new Refused("A browser URL is required.");
    try {
      const parsed = new URL(value);
      if (!["http:", "https:", "about:"].includes(parsed.protocol)) throw new Error();
      return parsed.href;
    } catch { throw new Refused("Use an http, https or about URL."); }
  }

  private async open(args: Record<string, unknown>): Promise<CuaBrowserResult> {
    if (Object.keys(args).some(key => key !== "url")) throw new Refused("Only a URL is accepted for owned opening.");
    const url = this.url(args.url);
    if (this.cleanupUnconfirmed) throw new CleanupUnconfirmed("Earlier native cleanup is still unconfirmed. Inspect the owned runtime before reopening.");
    if (this.owned) throw new Refused("A browser already belongs to this session. Navigate it or close it; CUA has no standalone new-tab tool.");
    const driver = await this.createDriver();
    this.owned = { driver, session: `pi-browser-${randomUUID()}`, tabs: [] };
    await this.native("start_session");
    const prepared = object((await this.native("browser_prepare", { allow_launch: true, profile: { mode: "isolated_new" } }, true)).structuredContent);
    if (prepared.prepared !== true || prepared.action !== "launched_isolated_browser") throw new Error("CUA did not confirm a new isolated browser.");
    const pid = positive(prepared.prepared_pid);
    const windows = object((await this.native("list_windows", { pid })).structuredContent).windows;
    if (!Array.isArray(windows) || windows.length !== 1) throw new Error("The isolated launch did not produce one exact owned window.");
    const window = object(windows[0]);
    if (window.pid !== pid) throw new Error("CUA window does not belong to the prepared browser.");
    this.owned.target = { pid, window_id: positive(window.window_id) };
    this.owned.identity = await driver.identity(this.owned.target, true, this.signal);
    if (!this.owned.identity) throw new Error("The owned browser window lifetime could not be established.");
    await this.bind();
    const active = this.owned.tabs.filter(tab => tab.active);
    if (this.owned.tabs.length !== 1 || active.length !== 1) throw new Error("A new isolated browser must have exactly one active tab.");
    this.owned.focused = active[0].tab_id;
    await this.native("set_agent_cursor_enabled", { enabled: true });
    await this.native("set_agent_cursor_motion", { glide_duration_ms: 250, idle_hide_ms: 5000 });
    await this.native("browser_navigate", { ...this.page(), url }, true);
    return this.observe({});
  }

  private hint(): string {
    let value = this.offset++;
    let hint = "";
    do { hint = String.fromCharCode(97 + value % 26) + hint; value = Math.floor(value / 26) - 1; } while (value >= 0);
    return hint;
  }

  private async snapshot(): Promise<Record<string, unknown>> {
    // A fresh snapshot invalidates all old aliases, even if parsing later fails.
    this.aliases.clear();
    const state = object((await this.native("get_browser_state", { ...this.page(), snapshot_format: "semantic_v2" })).structuredContent);
    if (!Array.isArray(state.refs)) throw new Error("CUA returned no semantic action refs.");
    for (const value of state.refs) {
      const ref = object(value);
      if (typeof ref.ref !== "string" || !Array.isArray(ref.actions)) throw new Error("CUA returned an invalid semantic ref.");
      const alias: Alias = { ref: ref.ref, hint: this.hint(), actions: ref.actions.map(String), role: String(ref.role ?? ""), name: String(ref.name ?? ""),
        ...(typeof ref.value === "string" ? { value: ref.value } : {}) };
      this.aliases.set(alias.hint, alias);
    }
    return state;
  }

  private imageResult(native: DriverResult, kind: ImageContext["kind"], context: Pick<ImageContext, "page" | "bounds">, foreground: Record<string, unknown>, settings?: CuaImageSettings): CuaBrowserResult {
    const state = object(native.structuredContent);
    const width = positive(kind === "window" ? state.screenshot_width : state.width);
    const height = positive(kind === "window" ? state.screenshot_height : state.height);
    const mime = kind === "window" ? "image/png" : "image/jpeg";
    const images = native.content.filter(block => block.type === "image" && block.mimeType === mime);
    if (images.length !== 1 || images[0].type !== "image") throw new Error("CUA returned no exact native image.");
    if (kind === "window" && typeof state.capture_id !== "string") throw new Error("CUA window capture has no scoped capture ID.");
    this.image = { ...context, kind, width, height, ...(kind === "window" ? { captureId: state.capture_id as string } : {}) };
    const bytes = Buffer.from(images[0].data, "base64");
    const agent_image = { route: kind === "window" ? "cua_window" : "cua_fresh_zoom", coordinate_space: kind === "window" ? "window_image_pixels" : "zoom_image_pixels",
      configuration: settings ? { ...settings, kernel: "lanczos3" } : { kernel: "lanczos3", padding: "20% each side", maxWidth: 500 },
      output: { width, height, bytes: bytes.length, mimeType: mime, hash: createHash("sha256").update(bytes).digest("hex") }, foreground, native: state };
    return this.result("observed", kind === "window" ? "CUA raised the owned browser before capture; keyboard focus may change. Native window image includes browser chrome. Semantic hints use page refs, not these pixels." :
      "CUA raised the owned browser before fresh native zoom; keyboard focus may change. This padded detail is not a retained or nested crop.", { tab: this.tabNumber(), foreground, agent_image, screenshot: { width, height }, native: state }, images);
  }

  private async capture(foreground: Record<string, unknown>): Promise<CuaBrowserResult> {
    const settings = { ...this.settings() };
    if (!Number.isSafeInteger(settings.maxLongEdge) || settings.maxLongEdge < 64 || settings.maxLongEdge > 4096 || !Number.isFinite(settings.scale) || settings.scale < 0.05 || settings.scale > 1)
      throw new Refused("Use a long edge 64..4096 and scale 0.05..1.");
    const cap = Math.max(1, Math.floor(settings.maxLongEdge * settings.scale));
    this.image = undefined;
    const page = this.pageKey(await this.requireFocused());
    const native = await this.native("get_window_state", { ...this.owned!.target, include_accessibility_tree: false, max_image_dimension: cap });
    if (page !== this.pageKey(await this.requireFocused())) throw new Error("The owned page changed during native capture.");
    const bounds = this.boundsKey(native.structuredContent?.window_bounds);
    const result = this.imageResult(native, "window", { page, bounds }, foreground, settings);
    if (Math.max(this.image!.width, this.image!.height) > cap) throw new Error("CUA image exceeded the requested native cap.");
    return result;
  }

  private async observe(args: Record<string, unknown>): Promise<CuaBrowserResult> {
    if (Object.keys(args).some(key => !["image_only", "zoom"].includes(key)) ||
      (args.image_only !== undefined && typeof args.image_only !== "boolean") || (args.zoom && args.image_only !== undefined))
      throw new Refused("Use image_only or native zoom. Saved crop, region capture and hint overlays are unavailable on this CUA route.");
    if (args.zoom) {
      if (!this.image || this.image.kind !== "window") throw new Refused("Native zoom needs a fresh overview, not a previous zoom or consumed image.");
      const region = object(args.zoom);
      const { x, y, width, height } = region;
      if (Object.keys(region).sort().join(",") !== "height,width,x,y" ||
        ![x, y, width, height].every(v => typeof v === "number" && Number.isFinite(v)) ||
        (x as number) < 0 || (y as number) < 0 || (width as number) <= 0 || (height as number) <= 0 ||
        (x as number) + (width as number) > this.image.width || (y as number) + (height as number) > this.image.height || (width as number) > 500)
        throw new Refused("Zoom must fit within the last overview; its region width cannot exceed 500px.");
      await this.checkImage();
      const foreground = await this.foreground();
      await this.checkImage();
      const context = this.image!;
      this.image = undefined;
      return this.imageResult(await this.native("zoom", { ...this.owned!.target, x1: x, y1: y, x2: (x as number) + (width as number), y2: (y as number) + (height as number) }), "zoom", context, foreground);
    }
    await this.requireFocused();
    const foreground = await this.foreground();
    const state = args.image_only ? undefined : await this.snapshot();
    const result = await this.capture(foreground);
    if (state) {
      const elements = [...this.aliases.values()].map(({ ref: _ref, actions: _actions, ...alias }) => alias);
      const text = `${result.details.text}\n${String(state.outline ?? "")}\nHints belong only to this CUA snapshot.\n${elements.map(e => `${e.hint}: ${e.role} ${JSON.stringify(e.name)}${e.value !== undefined ? ` = ${JSON.stringify(e.value)}` : ""}`).join("\n")}`;
      result.content[0] = { type: "text", text };
      Object.assign(result.details, { text, elements, page: state.page, snapshot: state.snapshot });
    }
    return result;
  }

  private tabNumber(): number { return this.owned!.tabs.findIndex(tab => tab.tab_id === this.owned!.focused) + 1; }
  private async list(): Promise<CuaBrowserResult> {
    if (!this.owned) return this.result("listed", "No owned browser tabs.", { tabs: [] });
    const state = await this.binding();
    if (state.tabs.length !== 1) { this.aliases.clear(); this.image = undefined; }
    return this.result("listed", "Owned CUA tabs; listing does not activate a tab. Window-image work requires one active tab.", { tabs: state.tabs.map((tab, index) =>
      ({ tab: index + 1, title: tab.title, url: tab.url, focused: state.tabs.length === 1 && tab.active, active: tab.active })) });
  }
  private async focus(args: Record<string, unknown>): Promise<CuaBrowserResult> {
    if (Object.keys(args).some(key => key !== "tab") || !Number.isSafeInteger(args.tab) || (args.tab as number) < 1) throw new Refused("Choose a listed owned tab number.");
    await this.bind();
    const tab = this.owned!.tabs[(args.tab as number) - 1];
    if (!tab) throw new Refused("Unknown owned tab.");
    if (!tab.active) throw new Refused("CUA has no public tab-activate tool. Activate this owned tab yourself before focusing its window image.");
    this.owned!.focused = tab.tab_id;
    this.aliases.clear(); this.image = undefined;
    return this.observe({});
  }

  private alias(value: unknown, action: string): Alias {
    if (typeof value !== "string" || !this.aliases.has(value)) throw new Refused("Unknown or retired hint in the focused CUA snapshot.");
    const alias = this.aliases.get(value)!;
    if (!alias.actions.includes(action)) throw new Refused("The current CUA ref does not advertise this action.");
    return alias;
  }

  private async act(args: Record<string, unknown>): Promise<CuaBrowserResult> {
    const keys = ["click", "fill", "navigate", "hover", "scroll"].filter(key => args[key] !== undefined);
    if (keys.length !== 1 || Object.keys(args).some(key => ![...keys, "text", "observe", "wait_ms"].includes(key)) ||
      (args.observe !== undefined && typeof args.observe !== "boolean") ||
      (args.wait_ms !== undefined && (!Number.isInteger(args.wait_ms) || (args.wait_ms as number) < 0 || (args.wait_ms as number) > 5000)))
      throw new Refused("Choose one supported CUA click, fill, navigate, hover or scroll. Keyboard programs, new tabs and tab-close are unavailable.");
    const action = keys[0];
    if (action !== "fill" && args.text !== undefined) throw new Refused("Text belongs only to fill.");
    let name: string;
    let input: Record<string, unknown>;
    if (action === "navigate") { name = "browser_navigate"; input = { ...this.page(), url: this.url(args.navigate) }; }
    else if (action === "click" && typeof args.click === "object") {
      const point = object(args.click);
      if (!this.image || Object.keys(point).sort().join(",") !== "x,y" ||
        typeof point.x !== "number" || !Number.isFinite(point.x) || typeof point.y !== "number" || !Number.isFinite(point.y) ||
        point.x < 0 || point.y < 0 || point.x >= this.image.width || point.y >= this.image.height)
        throw new Refused("A coordinate click must fit the fresh returned image.");
      name = "click";
      input = { ...this.owned!.target, x: point.x, y: point.y, delivery_mode: "background",
        ...(this.image.kind === "zoom" ? { from_zoom: true } : { capture_id: this.image.captureId }) };
    } else if (action === "fill") {
      if (typeof args.text !== "string" || args.text.length > 4000) throw new Refused("Fill needs text up to 4000 characters.");
      name = "browser_type"; input = { ...this.page(), ref: this.alias(args.fill, "type").ref, text: args.text, replace: true };
    } else if (action === "scroll") {
      const scroll = object(args.scroll);
      if (Object.keys(scroll).sort().join(",") !== "delta_y,hint" || typeof scroll.delta_y !== "number" || !Number.isFinite(scroll.delta_y) || Math.abs(scroll.delta_y) > 2000)
        throw new Refused("Scroll needs a current hint and delta_y within -2000..2000 CSS pixels.");
      name = "browser_pointer"; input = { ...this.page(), ref: this.alias(scroll.hint, "pointer").ref, action: "scroll", delta_y: scroll.delta_y, delivery_mode: "background", input_route: "trusted" };
    } else {
      name = action === "hover" ? "browser_pointer" : "browser_click";
      input = { ...this.page(), ref: this.alias(args[action], action === "hover" ? "pointer" : "click").ref, delivery_mode: "background", input_route: "trusted",
        ...(action === "hover" ? { action: "hover" } : {}) };
    }
    if (name === "click") await this.checkImage();
    else await this.requireFocused();
    this.image = undefined;
    if (action === "navigate") this.aliases.clear();
    const native = await this.native(name, input, true);
    if (this.signal?.aborted) throw new Error("Cancelled after native input admission.");
    if (args.wait_ms) await delay(args.wait_ms as number, undefined, { signal: this.signal });
    if (args.observe === false) return this.result("acted", "CUA input finished; site effect is not yet verified. Observe after the sequence.", { tab: this.tabNumber(), action, native: native.structuredContent });
    return this.observe({ image_only: args.observe !== true });
  }

  private async dispose(): Promise<void> {
    const owned = this.owned;
    this.owned = undefined; this.aliases.clear(); this.image = undefined;
    if (!owned) {
      if (this.cleanupUnconfirmed) throw new CleanupUnconfirmed("Earlier native cleanup is still unconfirmed.");
      return;
    }
    try {
      const result = await owned.driver.call("end_session", { session: owned.session });
      if (result.isError || result.structuredContent?.active !== false) throw new Error("Session end was not confirmed.");
    } catch (error) {
      this.cleanupUnconfirmed = true;
      throw new CleanupUnconfirmed(`CUA session cleanup is not confirmed: ${String(error)}`);
    } finally {
      try { await owned.driver.close(); }
      catch (error) { this.cleanupUnconfirmed = true; throw new CleanupUnconfirmed(`Owned transport cleanup failed: ${String(error)}`); }
    }
  }
}
