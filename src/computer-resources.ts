import { randomUUID } from "node:crypto";
import { parseComputerAddress, computerSource, type ComputerAddress } from "./computer-address.ts";
import { parseComputerViews } from "./computer-views.ts";
import type { ComputerSession, ComputerResult, Action } from "./session.ts";
import { parseWindowManagement, type WindowManagementCommand } from "./window-management.ts";

/** A rejected request whose validation completed before native dispatch. */
export class ComputerRequestError extends Error {}
function commandObject(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)); }
  catch { throw new ComputerRequestError("Use one valid JSON command object."); }
}
type ObservationTarget = { window_ref: string; display?: never } | { display: string; window_ref?: never };
interface Snapshot { target: ObservationTarget; result: ComputerResult }
const text = (result: ComputerResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComputerRequestError("Use a JSON command object.");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new ComputerRequestError("Command contains unsupported fields.");
}

/** Addressable projections of one ComputerSession. Cached descriptors never acquire native pixels. */
export class ComputerResources {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly windowStates = new Map<string, { window_ref: string; result: ComputerResult }>();
  private readonly apps = new Map<string, string>();

  /** Give installed paths opaque addresses; paths themselves are not session references. */
  appSource(id: string): string {
    let ref = [...this.apps].find(([, app]) => app === id)?.[0];
    if (!ref) { ref = randomUUID(); this.apps.set(ref, id); }
    return computerSource("app", ref);
  }
  constructor(private readonly getSession: (cwd: string) => Promise<ComputerSession>,
    private readonly closeSession: () => Promise<ComputerResult>) {}

  private snapshot(id: string): Snapshot {
    const entry = this.snapshots.get(id);
    if (!entry) throw new ComputerRequestError("Observation reference expired. Read a new window/display overview.");
    return entry;
  }
  private retireWindow(ref: string): void {
    for (const [id, entry] of this.windowStates) if (entry.window_ref === ref) this.windowStates.delete(id);
    for (const [id, entry] of this.snapshots) if (entry.target.window_ref === ref) this.snapshots.delete(id);
  }
  private remember(target: ObservationTarget, result: ComputerResult): ComputerResult {
    const id = result.details.observation_id ?? result.details.agent_image?.image_id;
    if (result.details.status !== "observed" || typeof id !== "string") return result;
    for (const [old, entry] of this.snapshots)
      if (entry.target.window_ref === target.window_ref && entry.target.display === target.display) this.snapshots.delete(old);
    this.snapshots.set(id, { target, result });
    // Match the backend's small pixel-retention window; eviction never renews references.
    while (this.snapshots.size > 3) this.snapshots.delete(this.snapshots.keys().next().value!);
    return result;
  }

  /** Resolve an editor's readonly descriptor without native acquisition or target refresh. */
  descriptor(address: ComputerAddress): string {
    if (address.kind === "window-state") {
      const state = this.windowStates.get(address.ref);
      if (!state) throw new ComputerRequestError("Window state reference expired. Read the window with state view again.");
      const operations = state.result.details.window_state_kind === "management" ? "move/resize/minimize/maximize/focus or restore" : "restore";
      return `# Computer window state\nWindow: ${computerSource("window", state.window_ref)}\nState: ${address.source}\nInsert one ${operations} command consumes this state. No capture, typing or pointer authority. No native query occurred during descriptor resolution.`;
    }
    if (address.kind === "observation") {
      const snapshot = this.snapshot(address.ref);
      const source = snapshot.target.window_ref !== undefined ? computerSource("window", snapshot.target.window_ref)
        : computerSource("display", snapshot.target.display!);
      return `# Computer observation\nSource: ${source}\nObservation: ${computerSource("observation", address.ref)}\n` +
        (snapshot.result.details.dom ? "Readonly DOM snapshot. Cached Read and Search perform no new DOM query or authority renewal. Write and Insert are unavailable. CSS bounds are not native image coordinates."
          : snapshot.target.window_ref !== undefined ? "Input needs this still-current observation. Insert sends JSON commands; Write sends literal text."
          : "Display observation is readonly and grants no input authority.");
    }
    return `# Computer resource\nSource: ${address.source}\nUse Read for native observation, Search for discovery, and Insert for explicit commands. No native capture occurred during descriptor resolution.`;
  }

  /** Acquire a requested native projection, or inspect one explicitly issued observation. */
  async read(address: ComputerAddress, cwd: string, views?: readonly string[], signal?: AbortSignal): Promise<ComputerResult | undefined> {
    const view = parseComputerViews(views);
    if (address.kind === "session" || address.kind === "app") {
      if (views?.length) throw new ComputerRequestError("This resource has no native image views.");
      return undefined;
    }
    const session = await this.getSession(cwd);
    if (address.kind === "window-state") {
      if (views?.length) throw new ComputerRequestError("Cached window state has no capture or UI views. Read the window with state view for a fresh state.");
      const state = this.windowStates.get(address.ref);
      if (!state) throw new ComputerRequestError("Window state reference expired. Read the window with state view again.");
      const checked = await session.checkWindowState(state.window_ref, address.ref, signal);
      if (checked.details.status !== "observed") { this.windowStates.delete(address.ref); return checked; }
      return { ...state.result, content: state.result.content.map(block => block.type === "text"
        ? { ...block, text: block.text.replace(/^.*?(?=\n|$)/,
          "Cached native window state. No new metadata sample or renewed one-use authority. Insert consumes this state once.") }
        : block) };
    }
    if (view.kind === "sequence") {
      if (address.kind !== "window" && address.kind !== "display") throw new ComputerRequestError("Capture a sequence from a window/display address, not an observation.");
      const target = address.kind === "window" ? { window_ref: address.ref } : { display: address.ref };
      if (target.window_ref) for (const [id, entry] of this.windowStates)
        if (entry.window_ref === target.window_ref) this.windowStates.delete(id);
      for (const [id, entry] of this.snapshots) if (entry.target.window_ref === target.window_ref && entry.target.display === target.display) this.snapshots.delete(id);
      return session.captureSequence(target, view.options, signal);
    }
    if (address.kind === "sequence") {
      if (view.kind !== "frames") throw new ComputerRequestError("Select sequence images explicitly with frames:first|last|endpoints|changed|all or frames:{\"indexes\":[0]}.");
      return session.sequenceFrames(address.ref, view.selection, signal);
    }
    if (view.kind === "frames") throw new ComputerRequestError("Frame selection needs a sequence address.");
    if (address.kind === "windows" || address.kind === "apps" || address.kind === "displays") {
      if (views?.length) throw new ComputerRequestError("Use a returned window/display address for native views.");
      return session[address.kind](signal);
    }
    if (address.kind === "window") {
      // Fresh window Read retires both provider handles before any native acquisition.
      this.retireWindow(address.ref);
      if (view.kind === "state") {
        const result = await session.observeWindowState(address.ref, signal);
        if (result.details.status === "observed" && result.details.window_state_id) {
          this.windowStates.set(result.details.window_state_id, { window_ref: address.ref, result });
          while (this.windowStates.size > 64) this.windowStates.delete(this.windowStates.keys().next().value!);
        }
        return result;
      }
      if (view.kind === "dom") return this.remember({ window_ref: address.ref }, await session.observeDom(address.ref, view.options, signal));
      if (view.kind !== "overview") throw new ComputerRequestError("Read an overview, then apply region to its returned observation address.");
      return this.remember({ window_ref: address.ref }, await session.observe(address.ref, signal, undefined, undefined, undefined, view.capture));
    }
    if (address.kind === "display") {
      if (view.kind !== "overview" || Object.keys(view.capture).length) throw new ComputerRequestError("Read the display overview without capture options, then use its observation for region detail.");
      return this.remember({ display: address.ref }, await session.observeDisplay(address.ref, signal));
    }
    if (address.kind !== "observation") throw new ComputerRequestError("Use an existing supported computer resource.");
    const snapshot = this.snapshot(address.ref);
    if (address.hint || address.delivery || address.delayMs !== undefined)
      throw new ComputerRequestError("Hint/delivery/delay address options are for input, not Read.");
    if (snapshot.result.details.dom) {
      const ref = snapshot.target.window_ref;
      if (!ref) throw new ComputerRequestError("Readonly DOM requires a window source.");
      if (view.kind === "element") {
        if (view.operation === "geometry") return session.sampleDomGeometry(ref, address.ref, view.hint, signal);
        if (view.operation !== "scope") return session.inspectDom(ref, address.ref, { operation: view.operation, hint: view.hint }, signal);
        this.retireWindow(ref);
        return this.remember({ window_ref: ref }, await session.observeDom(ref, { scope: view.hint }, signal, address.ref));
      }
      if (view.kind === "dom" && Object.keys(view.options).length) {
        this.retireWindow(ref);
        return this.remember({ window_ref: ref }, await session.observeDom(ref, view.options, signal, address.ref));
      }
      if (view.kind !== "dom" && (view.kind !== "overview" || views?.length))
        throw new ComputerRequestError("Readonly DOM has no image/UI/state views or image-coordinate regions. Use a fresh window Read.");
      const checked = await session.checkDom(ref, address.ref, signal);
      if (checked.details.status !== "observed") { this.snapshots.delete(address.ref); return checked; }
      return { ...snapshot.result, details: { ...snapshot.result.details, state: { ...snapshot.result.details.state, cached_dom: true } },
        content: snapshot.result.content.map(block => block.type === "text" ? { ...block,
          text: "Cached readonly DOM snapshot. No new DOM query or authority renewal.\n" + block.text } : block) };
    }
    if (view.kind === "dom") throw new ComputerRequestError("This observation has no DOM scope. Read its window with dom view.");
    if (view.kind === "element") {
      if (!snapshot.target.window_ref) throw new ComputerRequestError("Display observations have no collected UI.");
      if (view.operation === "geometry") throw new ComputerRequestError("CSS geometry requires a current readonly DOM observation, not UI hints or image coordinates.");
      if (view.operation === "crop") this.snapshots.delete(address.ref);
      return session.observe(snapshot.target.window_ref, signal, undefined, undefined,
        { operation: view.operation, observation_id: address.ref, hint: view.hint });
    }
    if (view.kind === "region") {
      // Retire the provider handle even when detail refuses; never turn detail into an input target.
      this.snapshots.delete(address.ref);
      const imageId = snapshot.result.details.agent_image?.image_id;
      if (typeof imageId !== "string") throw new ComputerRequestError("This observation has no image for detail.");
      const zoom = { image_id: imageId, ...view.region };
      return snapshot.target.window_ref !== undefined ? session.observe(snapshot.target.window_ref, signal, undefined, zoom)
        : session.observeDisplay(snapshot.target.display!, signal, zoom);
    }
    const checked = await session.checkObservation(snapshot.target, address.ref, signal);
    if (checked.details.status !== "observed") { this.snapshots.delete(address.ref); return checked; }
    if (view.kind !== "overview") throw new ComputerRequestError("Unsupported observation view.");
    if (Object.keys(view.capture).some(key => key !== "granularity")) throw new ComputerRequestError("Acquisition options require a fresh window Read, not a stored observation.");
    if (view.capture.granularity === "ui" && !snapshot.result.details.ui) throw new ComputerRequestError("This observation has no collected UI. Read a new UI/full window overview.");
    if (view.capture.granularity === "image" && !snapshot.result.content.some(block => block.type === "image"))
      throw new ComputerRequestError("This observation has no pixels. Read a new image/full window overview.");
    return snapshot.result;
  }

  /** Search permitted discovery metadata or the current collected UI without another native walk. */
  async search(address: ComputerAddress, cwd: string, query: string, limit?: number, signal?: AbortSignal): Promise<ComputerResult> {
    const session = await this.getSession(cwd);
    if (address.kind === "windows" || address.kind === "apps") return session[address.kind](signal, query);
    if (address.kind === "displays") {
      if (query) throw new ComputerRequestError("Display discovery does not accept a text predicate.");
      return session.displays(signal);
    }
    if (address.kind !== "observation") throw new ComputerRequestError("Search computer:windows, computer:apps, computer:displays or a returned observation address.");
    if (address.hint || address.delivery || address.delayMs !== undefined) throw new ComputerRequestError("Input options do not select a Search scope.");
    const snapshot = this.snapshot(address.ref);
    if (!snapshot.target.window_ref) throw new ComputerRequestError("Display images have no native UI search scope.");
    if (snapshot.result.details.dom) return session.inspectDom(snapshot.target.window_ref, address.ref,
      { operation: "search", query, ...(limit !== undefined ? { limit } : {}) }, signal);
    return session.observe(snapshot.target.window_ref, signal, undefined, undefined,
      { operation: "search", observation_id: address.ref, query, ...(limit !== undefined ? { limit } : {}) });
  }

  /** Dispatch exactly one literal Write or JSON Insert against its address-bound target. */
  async perform(address: ComputerAddress, cwd: string, value: string, tool: "write" | "insert", signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind === "window-state") {
      if (tool !== "insert") throw new ComputerRequestError("Window state grants native control through Insert, never literal Write.");
      const command = commandObject(value);
      let management: WindowManagementCommand | undefined;
      if (command.action === "restore") only(command, ["action"]);
      else {
        try { management = parseWindowManagement(command); }
        catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
      }
      const state = this.windowStates.get(address.ref);
      if (!state) throw new ComputerRequestError("Window state reference expired. Read the window with state view again.");
      this.windowStates.delete(address.ref);
      const session = await this.getSession(cwd);
      return management ? session.manageWindow(state.window_ref, address.ref, management, signal)
        : session.restoreWindow(state.window_ref, address.ref, signal);
    }
    if (tool === "insert" && (address.kind === "session" || address.kind === "app")) {
      const command = commandObject(value);
      if (command.action === "close" && address.kind === "session") {
        only(command, ["action"]);
        this.snapshots.clear();
        this.windowStates.clear();
        this.apps.clear();
        return this.closeSession();
      }
      if (command.action === "open_browser" && address.kind === "session") {
        only(command, ["action"]);
        const result = await (await this.getSession(cwd)).openBrowser(signal);
        return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
      }
      if (command.action !== "open") throw new ComputerRequestError("Use open for an app, or close to release the computer session; it does not close application documents.");
      only(command, address.kind === "app" ? ["action"] : ["action", "app"]);
      const app = address.kind === "app" ? this.apps.get(address.ref) : command.app;
      if (typeof app !== "string" || !app.trim()) throw new ComputerRequestError("Open needs an installed app identifier or exact name.");
      const result = await (await this.getSession(cwd)).open(app, signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (address.kind !== "observation") throw new ComputerRequestError("Input needs the observation address returned by a fresh window Read.");
    const snapshot = this.snapshot(address.ref);
    if (snapshot.result.details.dom) throw new ComputerRequestError("Readonly DOM observations grant no Write or Insert authority. Read a fresh window UI/image overview for input.");
    if (!snapshot.target.window_ref) throw new ComputerRequestError("Display observations are readonly; choose a window overview for input.");
    let command: Record<string, unknown>;
    if (tool === "write") {
      command = { action: "type_text", text: value, ...(address.delayMs !== undefined ? { delay_ms: address.delayMs } : {}) };
    } else {
      if (address.delayMs !== undefined) throw new ComputerRequestError("delay_ms in the resource address is only for literal Write.");
      command = commandObject(value);
      if ("window_ref" in command || "observation_id" in command) throw new ComputerRequestError("The resource address binds the window and observation; omit identity fields from JSON.");
    }
    if (address.hint !== undefined) {
      if ("hint" in command || "element_token" in command || "x" in command || "y" in command)
        throw new ComputerRequestError("Choose the address hint or a JSON target, not both.");
      command.hint = address.hint;
    }
    if (address.delivery !== undefined) {
      if ("delivery_mode" in command) throw new ComputerRequestError("Choose delivery in the address or JSON, not both.");
      command.delivery_mode = address.delivery;
    }
    const action = { ...command, window_ref: snapshot.target.window_ref, observation_id: address.ref } as Action;
    this.snapshots.delete(address.ref);
    return (await this.getSession(cwd)).act(action, signal);
  }
}

/** Parse a tool-owned path without allowing an unknown computer URI to fall through to files. */
export function requireComputerAddress(source: string): ComputerAddress {
  const address = parseComputerAddress(source);
  if (!address) throw new ComputerRequestError("Not a computer resource.");
  return address;
}

/** The actual native result text, useful for refusal and uncertainty receipts. */
export function computerResultText(result: ComputerResult): string { return text(result); }
