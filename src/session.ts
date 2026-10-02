import { randomUUID } from "node:crypto";

/** Exact Windows process/window identity. No desktop or implicit-window targets. */
export interface WindowTarget { pid: number; window_id: number }
/** Model-visible text or screenshot from the native Driver. */
export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
/** Native MCP result; structured state is kept separate from image content. */
export interface DriverResult {
  content: Content[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
/** Session-owned backend. Implementations must honour cancellation and close their owned runtime. */
export interface Driver {
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DriverResult>;
  close(): Promise<void>;
}
/** Experimental action surface, grounded in the latest observation of an authorized window. */
export interface Action {
  target: WindowTarget;
  observation_id: string;
  action: "type_text" | "set_value" | "click" | "select_all" | "key";
  delivery_mode?: "background" | "foreground";
  element_token?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
}
/** PoC outcomes deliberately do not claim that delivered input completed a task. */
export interface ComputerResult {
  content: Content[];
  details: {
    status: "listed" | "observed" | "delivered" | "refused" | "unknown" | "closed";
    target: WindowTarget;
    observation_id?: string;
    state?: Record<string, unknown>;
  };
  isError?: boolean;
}

/** One operator-authorized window, one current observation, and serialized native work. */
export class ComputerSession {
  private tail: Promise<unknown> = Promise.resolve();
  private observation?: { id: string; tokens: Set<string>; hasImage: boolean; captureId?: string };

  constructor(private readonly driver: Driver, private readonly target: WindowTarget) {}

  private queue(work: () => Promise<ComputerResult>): Promise<ComputerResult> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private result(status: ComputerResult["details"]["status"], message: string,
    state?: Record<string, unknown>, extra: Partial<ComputerResult["details"]> = {}, images: Content[] = []): ComputerResult {
    const details = { status, target: this.target, ...extra, ...(state ? { state } : {}) };
    const json = JSON.stringify(details, null, 2);
    const visible = json.length > 24_000
      ? json.slice(0, 24_000) + "\n[Text view truncated; narrow the observation. Full structured details are retained.]"
      : json;
    return { content: [{ type: "text", text: `${message}\n${visible}` }, ...images], details,
      ...(["refused", "unknown"].includes(status) ? { isError: true } : {}) };
  }

  private matches(target: WindowTarget): boolean {
    return target.pid === this.target.pid && target.window_id === this.target.window_id;
  }

  private async failed(error: unknown, dispatched: boolean): Promise<ComputerResult> {
    this.observation = undefined;
    await this.driver.close().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    return this.result(dispatched ? "unknown" : "refused", dispatched
      ? `Action outcome unknown: the window may have changed. Observe again before deciding or retrying. ${reason}`
      : `Computer use failed without confirmed observation. Check setup and observe again. ${reason}`);
  }

  /** Discover only the configured window. Other windows' contents are not inspected. */
  windows(signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (signal?.aborted) return this.result("refused", "Cancelled before discovery.");
      try {
        const native = await this.driver.call("list_windows", { pid: this.target.pid }, signal);
        if (native.isError) return this.result("refused", "Driver refused discovery.", native.structuredContent);
        const state = native.structuredContent ?? {};
        const windows = Array.isArray(state.windows) ? state.windows.filter((window) => {
          const item = window as WindowTarget;
          return this.matches(item);
        }) : [];
        return this.result("listed", "Authorized window discovery.", { ...state, windows });
      } catch (error) { return this.failed(error, false); }
    });
  }

  /** Replace the previous observation with fresh UI state and a scoped screenshot. */
  observe(target: WindowTarget, signal?: AbortSignal, query?: string): Promise<ComputerResult> {
    return this.queue(async () => {
      if (!this.matches(target)) return this.result("refused", "Target is not the operator-authorized window.");
      if (signal?.aborted) return this.result("refused", "Cancelled before observation.");
      this.observation = undefined;
      try {
        const native = await this.driver.call("get_window_state", {
          ...target, max_elements: 200, max_depth: 15, timeout_ms: 5000,
          max_image_dimension: 1280, ...(query ? { query } : {}),
        }, signal);
        if (native.isError) return this.result("refused", "Driver refused observation.", native.structuredContent);
        const state = native.structuredContent;
        if (!state || !Array.isArray(state.elements)) throw new Error("Driver returned no structured UI elements.");
        const images = native.content.filter((block) => block.type === "image");
        if (!images.length) throw new Error("Driver returned no grounding screenshot.");
        const id = randomUUID();
        const tokens = new Set(state.elements.map((element) => (element as { element_token?: unknown }).element_token)
          .filter((token): token is string => typeof token === "string"));
        this.observation = { id, tokens, hasImage: true,
          captureId: typeof state.capture_id === "string" ? state.capture_id : undefined };
        return this.result("observed", "Fresh window observation. Use observation_id for one action, then read again.",
          state, { observation_id: id }, images);
      } catch (error) { return this.failed(error, false); }
    });
  }

  /** Consume one observation before dispatch. There is no automatic retry or rollback. */
  act(action: Action, signal?: AbortSignal): Promise<ComputerResult> {
    return this.queue(async () => {
      if (!this.matches(action.target)) return this.result("refused", "Target is not the operator-authorized window.");
      if (signal?.aborted) return this.result("refused", "Cancelled before action dispatch.");
      const observed = this.observation;
      if (!observed || action.observation_id !== observed.id)
        return this.result("refused", "Stale or missing observation_id. Observe again.");
      const pixel = action.x !== undefined || action.y !== undefined;
      if (action.element_token && !observed.tokens.has(action.element_token))
        return this.result("refused", "Element token does not belong to the current window observation.");
      if (pixel && (action.element_token || !Number.isFinite(action.x) || !Number.isFinite(action.y)
        || action.x! < 0 || action.y! < 0 || !observed.hasImage))
        return this.result("refused", "Use either an element token or two non-negative screenshot coordinates.");
      if (["type_text", "set_value"].includes(action.action) && action.text === undefined)
        return this.result("refused", "This text action needs text.");
      if (action.action === "set_value" && !action.element_token)
        return this.result("refused", "set_value needs an observed element token.");
      if (action.action === "click" && !action.element_token && !pixel)
        return this.result("refused", "click needs an observed element token or screenshot coordinates.");
      if (action.action === "key" && !["backspace", "delete", "left", "right", "home", "end", "return", "escape", "tab"].includes(action.key ?? ""))
        return this.result("refused", "Unsupported PoC key.");
      const nativeName = action.action === "select_all" ? "hotkey" : action.action === "key" ? "press_key" : action.action;
      const args: Record<string, unknown> = {
        delivery_mode: action.delivery_mode ?? "background",
        ...(action.action === "set_value"
          ? { ...action.target }
          : { target: { kind: "window", ...action.target } }),
        ...(action.element_token ? { element_token: action.element_token } : {}),
        ...(pixel ? { x: action.x, y: action.y } : {}),
        ...(action.action === "click" && observed.captureId && pixel ? { capture_id: observed.captureId } : {}),
        ...(action.action === "type_text" ? { text: action.text } : {}),
        ...(action.action === "set_value" ? { value: action.text } : {}),
        ...(action.action === "select_all" ? { keys: ["ctrl", "a"] } : {}),
        ...(action.action === "key" ? { key: action.key } : {}),
      };
      this.observation = undefined;
      try {
        const native = await this.driver.call(nativeName, args, signal);
        const state = native.structuredContent ?? {};
        const nativeText = native.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        const refused = state.effect === "refused" || ["invalid_action_target", "invalid_arguments",
          "stale_element_token", "conflicting_element_target", "background_unavailable"].includes(String(state.code));
        const status = native.isError ? (refused ? "refused" : "unknown") : "delivered";
        return this.result(status,
          `Driver returned ${status} for ${nativeName} (requested: ${args.delivery_mode}). ${status === "unknown" ? "The window may have changed. " : ""}Observe again to verify application state.`,
          { ...state, ...(native.isError || !native.structuredContent ? { native_message: nativeText } : {}) });
      } catch (error) { return this.failed(error, true); }
    });
  }

  /** Idempotently release the owned runtime. This never closes application windows. */
  close(): Promise<ComputerResult> {
    return this.queue(async () => {
      this.observation = undefined;
      await this.driver.close();
      return this.result("closed", "Owned Driver runtime closed. Application windows were not closed.");
    });
  }
}
