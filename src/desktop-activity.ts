import { AsyncLocalStorage } from "node:async_hooks";
import type { VisualOptions, VisualSettings } from "./native-visuals.ts";

export type ActivityKind = "read" | "wait" | "click" | "drag" | "scroll" | "move_pointer" | "type" | "key" |
  "open" | "manage" | "browser" | "clipboard" | "files" | "record" | "other";
export interface DesktopAction {
  kind: ActivityKind;
  location: "desktop" | "browser" | "separate_desktop";
  window?: { window_id: number; pid: number; identity: string };
  delivery: "none" | "direct" | "unknown";
}
type End = "completed" | "interrupted";
type ActionEnd = End | "refused" | "unknown";
type Configuration = { operation: "configure"; label: string; panel: boolean; outline: boolean; point: boolean };
export type DesktopActivityMessage =
  | Configuration
  | { operation: "begin"; intent: string }
  | { operation: "end"; outcome: End }
  | ({ operation: "action_start"; id: number } & DesktopAction)
  | { operation: "action_end"; id: number; outcome: ActionEnd };
export type DesktopActivityStatus = "begun" | "active" | "ended" | "inactive" | "unsupported" | "unavailable";
export interface ActivityConnection { send(message: DesktopActivityMessage, timeout: number): Promise<boolean> }
interface State {
  connection: ActivityConnection;
  phase: "inactive" | "beginning" | "active" | "ending";
  configuration?: { request: Configuration; applied: Promise<boolean> };
  generation: number;
  ending?: Promise<DesktopActivityStatus>;
}
const context = new AsyncLocalStorage<{ state: State; generation: number; id: number; finished(): boolean }>();
const ACTION_MS = 100;
const SESSION_MS = 500;

/** One best-effort activity publisher. Native metadata is scoped to one explicit session and its exact MCP connection. */
export class DesktopActivity {
  private state?: State;
  private next = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly settings: VisualSettings, private readonly label: () => string | undefined) {
    this.unsubscribe = settings.subscribe(options => {
      const state = this.state;
      if (state?.configuration) void this.configure(state, options);
    });
  }

  get active(): boolean { return this.state?.phase === "active"; }

  attach(connection: ActivityConnection): void { this.state = { connection, phase: "inactive", generation: 0 }; }
  detach(connection: ActivityConnection): void { if (this.state?.connection === connection) this.state = undefined; }
  dispose(): void { this.state = undefined; this.unsubscribe(); }

  private async send(state: State, message: DesktopActivityMessage, timeout: number): Promise<boolean> {
    if (state !== this.state) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        state.connection.send(message, timeout),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeout); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); }
  }

  private configure(state: State, options: VisualOptions): Promise<boolean> {
    const { activity_panel: panel, activity_outlines: outline, activity_cursors: point } = options;
    const name = this.label()?.normalize("NFKC").replace(/[^\p{L}\p{N} ._-]/gu, "").trim() || "Agent";
    const suffix = ` · Pi ${process.pid}`;
    const label = [...name].slice(0, 48 - suffix.length).join("") + suffix;
    const previous = state.configuration;
    if (previous?.request.label === label && previous.request.panel === panel && previous.request.outline === outline && previous.request.point === point)
      return previous.applied;
    const request: Configuration = { operation: "configure", label, panel, outline, point };
    const applied = this.send(state, request, SESSION_MS).then(accepted => {
      if (!accepted && state.configuration?.request === request) state.configuration = undefined;
      return accepted;
    });
    state.configuration = { request, applied };
    return applied;
  }

  async begin(intent: string, signal?: AbortSignal): Promise<DesktopActivityStatus> {
    const state = this.state;
    if (!state || signal?.aborted || state.phase === "ending") return "unavailable";
    if (state.phase === "active" || state.phase === "beginning") return "active";
    state.phase = "beginning";
    const generation = ++state.generation;
    const current = () => this.state === state && state.phase === "beginning" && state.generation === generation;
    const interrupt = () => { if (current()) void this.end("interrupted"); };
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      if (!await this.configure(state, this.settings.current()) || !current() || signal?.aborted) return "unavailable";
      const accepted = await this.send(state, { operation: "begin", intent }, SESSION_MS);
      if (!current() || signal?.aborted) return "unavailable";
      if (!accepted) { await this.end("interrupted"); return "unavailable"; }
      state.phase = "active";
      return "begun";
    } finally {
      signal?.removeEventListener("abort", interrupt);
      if (state.phase === "beginning" && state.generation === generation) state.phase = "inactive";
    }
  }

  async end(outcome: End): Promise<DesktopActivityStatus> {
    const state = this.state;
    if (!state) return "inactive";
    if (state.ending) return state.ending;
    if (state.phase === "inactive") return "inactive";
    state.phase = "ending";
    return state.ending = this.send(state, { operation: "end", outcome }, SESSION_MS).then(accepted => {
      state.phase = "inactive";
      state.ending = undefined;
      return accepted ? "ended" : "unavailable";
    });
  }

  /** Get a native action correlation ID only when the call is inside this publisher's admitted desktop action. */
  id(connection: ActivityConnection | undefined): number | undefined {
    const scope = context.getStore();
    return scope && scope.state === this.state && scope.state.connection === connection && scope.state.phase === "active" &&
      scope.state.generation === scope.generation && !scope.finished() ? scope.id : undefined;
  }

  async run<T extends { details: { status: string } } | undefined>(action: DesktopAction, signal: AbortSignal | undefined,
    run: () => Promise<T>, isRefusal?: (error: unknown) => boolean): Promise<T> {
    const state = this.state;
    if (!state || state.phase !== "active" || signal?.aborted) return run();
    const id = ++this.next;
    const generation = state.generation;
    let finished = false;
    const finish = (outcome: ActionEnd) => {
      if (finished) return;
      finished = true;
      void this.send(state, { operation: "action_end", id, outcome }, ACTION_MS);
    };
    const interrupt = () => {
      finish("interrupted");
      if (this.state === state && state.generation === generation) void this.end("interrupted");
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      const { kind, location, delivery } = action;
      const target = location === "desktop" ? action.window : undefined;
      const window = target && { window_id: target.window_id, pid: target.pid, identity: target.identity };
      const accepted = await this.send(state, { operation: "action_start", id, kind, location, delivery, ...(window ? { window } : {}) }, ACTION_MS);
      const result = accepted && action.location === "desktop" && !signal?.aborted && state.phase === "active" && state.generation === generation
        ? await context.run({ state, generation, id, finished: () => finished }, run) : await context.exit(run);
      finish(signal?.aborted ? "interrupted" : result?.details.status === "refused" ? "refused" : result?.details.status === "unknown" ? "unknown" : "completed");
      return result;
    } catch (error) {
      finish(signal?.aborted ? "interrupted" : isRefusal?.(error) ? "refused" : "unknown");
      throw error;
    } finally {
      signal?.removeEventListener("abort", interrupt);
    }
  }
}
