import { randomUUID } from "node:crypto";
import { parseComputerAddress, computerSource, type ComputerAddress } from "./computer-address.ts";
import { parseComputerViews } from "./computer-views.ts";
import type { ComputerSession, ComputerResult, Action } from "./session.ts";
import { parseWindowManagement, type WindowManagementCommand } from "./window-management.ts";
import { validateWebAction, validateWebLaunch, type WebAction } from "./web-browser.ts";
import { combine, evaluateNative, type WaitSpec } from "./ui-conditions.ts";
import { diffDom, diffUi } from "./successor.ts";

/** A rejected request whose validation completed before native dispatch. */
export class ComputerRequestError extends Error {}
function commandObject(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)); }
  catch { throw new ComputerRequestError("Use one valid JSON command object."); }
}
/** Native actions a batch may run; each later step re-resolves its target in a fresh UI walk. */
const NATIVE_BATCH_ACTIONS = ["click", "double_click", "right_click", "type_text", "key", "hotkey", "scroll", "invoke", "select", "set_value"];
/** An action's optional postcondition and successor request. */
interface FollowUp { expect?: WaitSpec; successor: boolean; preexisting?: boolean }
type ObservationTarget = { window_ref: string; display?: never } | { display: string; window_ref?: never };
interface Snapshot { target: ObservationTarget; result: ComputerResult }
/** A running sandbox with its own guest session. */
export interface OpenedSandbox {
  ref: string;
  session: ComputerSession;
  describe(source: string): string;
  /** Release the guest session and destroy the sandbox. */
  close(): Promise<void>;
}
/** Start a sandbox for open_sandbox; validation errors are reported before any host work. */
export type SandboxFactory = (cwd: string, command: Record<string, unknown>, signal?: AbortSignal) => Promise<OpenedSandbox>;
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
  private readonly sandboxes = new Map<string, OpenedSandbox>();
  /** Sandbox launches still in progress; a cancelled launch finishes its own cleanup before it settles. */
  private readonly opening = new Set<Promise<unknown>>();

  /** Give installed paths opaque addresses; paths themselves are not session references. */
  appSource(id: string): string {
    let ref = [...this.apps].find(([, app]) => app === id)?.[0];
    if (!ref) { ref = randomUUID(); this.apps.set(ref, id); }
    return computerSource("app", ref);
  }
  constructor(private readonly getSession: (cwd: string) => Promise<ComputerSession>,
    private readonly closeSession: () => Promise<ComputerResult>, private readonly openSandbox?: SandboxFactory) {}

  /** The session that issued a window reference: a sandbox guest's, otherwise the host's. */
  private async sessionFor(cwd: string, window?: string): Promise<ComputerSession> {
    if (window) for (const sandbox of this.sandboxes.values()) if (sandbox.session.hasWindow(window)) return sandbox.session;
    return this.getSession(cwd);
  }
  private windowOf(address: ComputerAddress): string | undefined {
    return address.kind === "window" ? address.ref
      : address.kind === "window-state" ? this.windowStates.get(address.ref)?.window_ref
      : address.kind === "observation" ? this.snapshots.get(address.ref)?.target.window_ref : undefined;
  }
  private sandbox(ref: string): OpenedSandbox {
    const sandbox = this.sandboxes.get(ref);
    if (!sandbox) throw new ComputerRequestError("Sandbox reference expired. It was closed or this session was released.");
    return sandbox;
  }
  private async closeSandbox(sandbox: OpenedSandbox): Promise<ComputerResult> {
    this.sandboxes.delete(sandbox.ref);
    for (const [id, entry] of this.snapshots) if (entry.target.window_ref && sandbox.session.hasWindow(entry.target.window_ref)) this.snapshots.delete(id);
    for (const [id, entry] of this.windowStates) if (sandbox.session.hasWindow(entry.window_ref)) this.windowStates.delete(id);
    await sandbox.close();
    return { content: [{ type: "text", text: `Sandbox ${computerSource("sandbox", sandbox.ref)} destroyed. Its windows and observations are gone.` }],
      details: { status: "closed", mode: "yolo", sandbox_ref: sandbox.ref } };
  }
  /** Destroy every sandbox this session opened; used when the computer session closes or Pi shuts down. */
  async closeSandboxes(): Promise<void> {
    await Promise.allSettled([...this.opening]);
    await Promise.allSettled([...this.sandboxes.values()].map(sandbox => this.closeSandbox(sandbox)));
  }

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
    // A delivered DOM action carries the page's next snapshot, which becomes the current observation.
    const observed = result.details.status === "observed" || result.details.status === "delivered" && result.details.dom !== undefined;
    if (!observed || typeof id !== "string") return result;
    for (const [old, entry] of this.snapshots)
      if (entry.target.window_ref === target.window_ref && entry.target.display === target.display) this.snapshots.delete(old);
    this.snapshots.set(id, { target, result });
    // Match the backend's small pixel-retention window; eviction never renews references.
    while (this.snapshots.size > 3) this.snapshots.delete(this.snapshots.keys().next().value!);
    return result;
  }

  /** Whether an observation or window-state address still grants its one-use authority. Other addresses grant none. */
  grantsAuthority(address: ComputerAddress): boolean {
    return address.kind === "observation" ? this.snapshots.has(address.ref)
      : address.kind === "window-state" ? this.windowStates.has(address.ref) : false;
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
        (snapshot.result.details.dom ? "Playwright DOM snapshot. Insert one JSON action with a target (aria ref or locator); Read element:crop|highlight,<ref> or image for page pixels. Search filters this snapshot. Write and native input are unavailable here."
          : snapshot.target.window_ref !== undefined ? "Input needs this still-current observation. Insert sends JSON commands; Write sends literal text."
          : "Display observation is readonly and grants no input authority.");
    }
    if (address.kind === "sandbox") return this.sandbox(address.ref).describe(address.source);
    return `# Computer resource\nSource: ${address.source}\nUse Read for native observation, Search for discovery, and Insert for explicit commands. No native capture occurred during descriptor resolution.`;
  }

  /** Acquire a requested native projection, or inspect one explicitly issued observation. */
  async read(address: ComputerAddress, cwd: string, views?: readonly string[], signal?: AbortSignal): Promise<ComputerResult | undefined> {
    const view = parseComputerViews(views);
    if (address.kind === "session" || address.kind === "app" || address.kind === "sandbox") {
      if (views?.length) throw new ComputerRequestError("This resource has no native image views.");
      if (address.kind === "sandbox") this.sandbox(address.ref);
      return undefined;
    }
    const session = await this.sessionFor(cwd, this.windowOf(address));
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
      if ([...this.sandboxes.values()].some(sandbox => sandbox.session === session)) throw new ComputerRequestError("Temporal capture is not available for sandbox windows.");
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
        if (view.operation !== "crop" && view.operation !== "highlight") throw new ComputerRequestError("A DOM observation supports element:crop|highlight,<aria ref>. Use dom:{\"target\":...} for a scoped snapshot.");
        return session.webImage(ref, address.ref, view.operation, { ref: view.hint }, signal);
      }
      if (view.kind === "dom" && Object.keys(view.options).length) {
        this.retireWindow(ref);
        return this.remember({ window_ref: ref }, await session.observeDom(ref, view.options, signal));
      }
      if (view.kind === "overview" && view.capture.granularity === "image" && Object.keys(view.capture).length === 1)
        return session.webImage(ref, address.ref, "page", undefined, signal);
      if (view.kind !== "dom" && (view.kind !== "overview" || views?.length))
        throw new ComputerRequestError("A DOM observation supports dom, image (page screenshot) and element:crop|highlight. Read the window for native views.");
      const checked = await session.checkDom(ref, address.ref, signal);
      if (checked.details.status !== "observed") this.snapshots.delete(address.ref);
      return checked;
    }
    if (view.kind === "dom") throw new ComputerRequestError("This observation has no DOM scope. Read its window with dom view.");
    if (view.kind === "element") {
      if (!snapshot.target.window_ref) throw new ComputerRequestError("Display observations have no collected UI.");
      if (view.operation === "text") return session.elementText(snapshot.target.window_ref, address.ref, view.hint);
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
    if (address.kind === "sandbox") return this.sandbox(address.ref).session.windows(signal, query);
    const session = await this.sessionFor(cwd, this.windowOf(address));
    if (address.kind === "windows" || address.kind === "apps") return session[address.kind](signal, query);
    if (address.kind === "displays") {
      if (query) throw new ComputerRequestError("Display discovery does not accept a text predicate.");
      return session.displays(signal);
    }
    if (address.kind !== "observation") throw new ComputerRequestError("Search computer:windows, computer:apps, computer:displays or a returned observation address.");
    if (address.hint || address.delivery || address.delayMs !== undefined) throw new ComputerRequestError("Input options do not select a Search scope.");
    const snapshot = this.snapshot(address.ref);
    if (!snapshot.target.window_ref) throw new ComputerRequestError("Display images have no native UI search scope.");
    if (snapshot.result.details.dom) return session.searchDom(snapshot.target.window_ref, address.ref, query, limit, signal);
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
      const session = await this.sessionFor(cwd, state.window_ref);
      return management ? session.manageWindow(state.window_ref, address.ref, management, signal)
        : session.restoreWindow(state.window_ref, address.ref, signal);
    }
    if (address.kind === "sandbox") {
      const sandbox = this.sandbox(address.ref);
      if (tool !== "insert") throw new ComputerRequestError("A sandbox address accepts Insert open or close, not literal Write.");
      const command = commandObject(value);
      if (command.action === "close") { only(command, ["action"]); return this.closeSandbox(sandbox); }
      if (command.action !== "open") throw new ComputerRequestError("A sandbox address accepts {\"action\":\"open\",\"app\":\"...\"} or {\"action\":\"close\"}.");
      only(command, ["action", "app"]);
      if (typeof command.app !== "string" || !command.app.trim()) throw new ComputerRequestError("Open needs an app name installed in the sandbox.");
      const result = await sandbox.session.open(command.app, signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (tool === "insert" && (address.kind === "session" || address.kind === "app")) {
      const command = commandObject(value);
      if (command.action === "open_sandbox" && address.kind === "session") {
        if (!this.openSandbox) throw new ComputerRequestError("Sandboxes are not available in this runtime.");
        const opening = this.openSandbox(cwd, command, signal);
        this.opening.add(opening);
        let sandbox: OpenedSandbox;
        try { sandbox = await opening; } finally { this.opening.delete(opening); }
        // Cancelled after the sandbox became ready: nobody will receive its address, so destroy it.
        if (signal?.aborted) { await sandbox.close(); throw new Error("Cancelled; the sandbox was destroyed."); }
        this.sandboxes.set(sandbox.ref, sandbox);
        const source = computerSource("sandbox", sandbox.ref);
        return { content: [{ type: "text", text: `Sandbox ready: ${source}\n${sandbox.describe(source)}` }],
          details: { status: "delivered", mode: "yolo", sandbox_ref: sandbox.ref } };
      }
      if (command.action === "close" && address.kind === "session") {
        only(command, ["action"]);
        await this.closeSandboxes();
        this.snapshots.clear();
        this.windowStates.clear();
        this.apps.clear();
        return this.closeSession();
      }
      if (command.action === "open_browser" && address.kind === "session") {
        let options;
        try { options = validateWebLaunch(command); }
        catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
        const result = await (await this.getSession(cwd)).openBrowser(options, signal);
        return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
      }
      if (command.action !== "open") throw new ComputerRequestError("Use open for an app, or close to release the computer session; it does not close application documents.");
      only(command, address.kind === "app" ? ["action"] : ["action", "app"]);
      const app = address.kind === "app" ? this.apps.get(address.ref) : command.app;
      if (typeof app !== "string" || !app.trim()) throw new ComputerRequestError("Open needs an installed app identifier or exact name.");
      const result = await (await this.getSession(cwd)).open(app, signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (address.kind === "window" && tool === "insert") {
      const command = commandObject(value);
      if (command.action !== "wait_for" && command.action !== "verify")
        throw new ComputerRequestError("A window address accepts only wait_for or verify. Input needs the observation address returned by a fresh window Read.");
      const session = await this.sessionFor(cwd, address.ref);
      let spec;
      try { spec = session.waitSpec(address.ref, command); }
      catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
      // A verification sample replaces the window's observations, like any fresh window Read.
      this.retireWindow(address.ref);
      return this.remember({ window_ref: address.ref }, await session.waitFor(address.ref, spec, signal));
    }
    if (address.kind !== "observation") throw new ComputerRequestError("Input needs the observation address returned by a fresh window Read.");
    const snapshot = this.snapshot(address.ref);
    const window = snapshot.target.window_ref;
    let input = value;
    let follow: FollowUp | undefined;
    if (tool === "insert" && window) {
      const command = commandObject(value);
      if (command.expect !== undefined || command.successor !== undefined) {
        follow = await this.followUpSpec(window, command, cwd);
        // Was the postcondition already true before anything is sent? Browsers sample now; native uses the input walk.
        if (follow.expect) {
          const session = await this.sessionFor(cwd, window);
          const earlier = snapshot.result.details.dom ? await session.webCheck(window, follow.expect.conditions, signal)
            : snapshot.result.details.ui ? evaluateNative(snapshot.result.details.ui, follow.expect.conditions) : undefined;
          follow.preexisting = earlier !== undefined && combine(earlier) === "satisfied";
        }
        delete command.expect; delete command.successor;
        input = JSON.stringify(command);
      }
      if (command.action === "batch") {
        const result = await this.batch(address, snapshot, command, cwd, signal);
        return follow ? this.followUp(window, snapshot, result, follow, cwd, signal) : result;
      }
    }
    const result = await this.act(address, snapshot, input, tool, cwd, signal);
    return follow && window ? this.followUp(window, snapshot, result, follow, cwd, signal) : result;
  }

  /** Dispatch one action against its observation: Playwright for DOM observations, CUA otherwise. */
  private async act(address: Extract<ComputerAddress, { kind: "observation" }>, snapshot: Snapshot, value: string, tool: "write" | "insert", cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    if (snapshot.result.details.dom) {
      if (tool !== "insert" || address.hint !== undefined || address.delivery !== undefined || address.delayMs !== undefined || !snapshot.target.window_ref)
        throw new ComputerRequestError("A DOM observation accepts one Insert JSON action with a target, not Write or address options.");
      let command;
      try { command = validateWebAction(commandObject(value)); }
      catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
      this.snapshots.delete(address.ref);
      const result = await (await this.sessionFor(cwd, snapshot.target.window_ref)).actDom(snapshot.target.window_ref, address.ref, command, signal);
      return result.details.dom ? this.remember({ window_ref: snapshot.target.window_ref }, result) : result;
    }
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
    return (await this.sessionFor(cwd, snapshot.target.window_ref)).act(action, signal);
  }

  /** Validate an action's optional `expect` postcondition and `successor` request before anything is dispatched. */
  private async followUpSpec(window: string, command: Record<string, unknown>, cwd: string): Promise<FollowUp> {
    if (command.successor !== undefined && typeof command.successor !== "boolean") throw new ComputerRequestError("successor must be boolean.");
    let expect: WaitSpec | undefined;
    if (command.expect !== undefined) {
      const raw = command.expect;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ComputerRequestError("expect must be an object with conditions and optional timeout_ms, interval_ms and stable.");
      try { expect = (await this.sessionFor(cwd, window)).waitSpec(window, { ...raw as Record<string, unknown>, action: "wait_for" }); }
      catch (error) { throw new ComputerRequestError(`expect: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { ...(expect ? { expect } : {}), successor: command.successor === true || expect !== undefined };
  }

  /**
   * After an action, wait for its declared postcondition and attach the successor observation with a compact
   * diff from the action's input observation. A refused or unknown action never yields a verified postcondition.
   */
  private async followUp(window: string, before: Snapshot, result: ComputerResult, follow: FollowUp, cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    const session = await this.sessionFor(cwd, window);
    const status = result.details.status;
    const preexisting = follow.preexisting === true;
    let successor: ComputerResult | undefined;
    let postcondition: ComputerResult["details"]["postcondition"];
    if (follow.expect && status !== "refused") {
      // Unknown delivery is sampled once for information, but never reported as verified.
      const spec = status === "unknown" ? { ...follow.expect, timeout_ms: 0, stable: 1 } : follow.expect;
      this.retireWindow(window);
      successor = this.remember({ window_ref: window }, await session.waitFor(window, spec, signal));
      const verification = successor.details.verification;
      const verdict = verification?.verdict ?? "unknown";
      postcondition = { status: status === "unknown" ? "unknown" : verdict === "satisfied" ? (preexisting ? "preexisting" : "verified") : verdict === "unsatisfied" ? "failed" : "unknown",
        ...(status === "unknown" ? { reason: "The action outcome is unknown, so its postcondition cannot be attributed to it." } : {}),
        ...(verification ? { verification } : {}) };
    } else if (follow.expect) {
      postcondition = { status: preexisting ? "preexisting" : "failed", reason: "The action was refused; nothing was sent." };
    } else if (status !== "refused") {
      if (result.details.dom) successor = result;
      else { this.retireWindow(window); successor = this.remember({ window_ref: window }, await session.observeQuiet(window, signal)); }
    }
    const after = successor?.details;
    const diff = before.result.details.dom && after?.dom ? diffDom(before.result.details.dom, after.dom)
      : before.result.details.ui && after?.ui ? diffUi(before.result.details.ui, after.ui) : undefined;
    // The successor replaces the action's own observation as the current one; a wait retired the earlier snapshot.
    const details = { ...result.details, ...(after?.observation_id ? { observation_id: after.observation_id, ...(after.dom ? { dom: after.dom } : {}) } : {}),
      ...(postcondition ? { postcondition } : {}),
      successor: after?.observation_id ? { observation_id: after.observation_id, ...(diff ? { diff } : { reason: "The input observation had no comparable UI or DOM." }) }
        : { reason: status === "refused" ? "The action was refused; the input observation is unchanged but consumed." : "No successor observation could be taken." } };
    return { ...result, details };
  }

  /**
   * Run up to 16 known steps in one call and stop at the first step that is not delivered or satisfied.
   * Browser steps are Playwright actions and conditions. Native steps re-resolve `target` {role,name,text}
   * against a fresh UI walk before each step; only the first step may use a hint or pixels of the current observation.
   */
  private async batch(address: Extract<ComputerAddress, { kind: "observation" }>, snapshot: Snapshot, command: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    only(command, ["action", "steps"]);
    const window = snapshot.target.window_ref!;
    if (address.hint !== undefined || address.delivery !== undefined || address.delayMs !== undefined) throw new ComputerRequestError("A batch takes its targets and delivery from its steps, not the address.");
    if (!Array.isArray(command.steps) || command.steps.length < 1 || command.steps.length > 16) throw new ComputerRequestError("batch needs steps: 1..16 step objects.");
    const session = await this.sessionFor(cwd, window);
    const browser = snapshot.result.details.dom !== undefined;
    type Step = { kind: "wait"; spec: WaitSpec; action: string } | { kind: "dom"; action: WebAction } | { kind: "native"; command: Record<string, unknown>; target?: Record<string, string> };
    const steps: Step[] = command.steps.map((raw, index): Step => {
      const step = object(raw);
      const label = `steps[${index}]`;
      try {
        if (step.action === "wait_for" || step.action === "verify") return { kind: "wait", spec: session.waitSpec(window, step), action: String(step.action) };
        if (browser) return { kind: "dom", action: validateWebAction(step) };
        if (!NATIVE_BATCH_ACTIONS.includes(String(step.action))) throw Error(`action must be one of ${NATIVE_BATCH_ACTIONS.join(", ")}, wait_for or verify.`);
        if (["window_ref", "observation_id", "sequence"].some(key => key in step)) throw Error("identity fields and nested sequences are not allowed.");
        const pinned = ["hint", "element_token", "x", "y"].some(key => key in step);
        if (pinned && index > 0) throw Error("only the first step may use a hint, token or pixels; later steps use target {role,name,text}.");
        let target: Record<string, string> | undefined;
        if (step.target !== undefined) {
          if (pinned) throw Error("choose target or a hint/pixel target, not both.");
          const value = object(step.target);
          if (!Object.keys(value).length || Object.entries(value).some(([key, item]) => !["role", "name", "text"].includes(key) || typeof item !== "string" || !item))
            throw Error("target needs non-empty role, name and/or text.");
          target = value as Record<string, string>;
        }
        const { target: _target, ...nativeStep } = step;
        return { kind: "native", command: nativeStep, ...(target ? { target } : {}) };
      } catch (error) { throw new ComputerRequestError(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    });
    this.snapshots.delete(address.ref);
    const started = performance.now();
    const rows: NonNullable<ComputerResult["details"]["batch"]>["steps"] = [];
    // `issued` holds the latest result whose observation is still current; a native action consumes it.
    let issued: ComputerResult | undefined, observation = address.ref, last: ComputerResult = snapshot.result, stop = "";
    for (const [index, step] of steps.entries()) {
      if (signal?.aborted) { stop = "Cancelled before the next step."; break; }
      if (step.kind === "wait") {
        this.retireWindow(window);
        last = this.remember({ window_ref: window }, await session.waitFor(window, step.spec, signal));
        issued = last.details.observation_id ? last : undefined;
        const verdict = last.details.verification?.verdict ?? "unknown";
        rows.push({ index, action: step.action, outcome: last.details.status, verdict });
        observation = last.details.observation_id ?? observation;
        if (last.details.status !== "observed" || verdict !== "satisfied") { stop = `Condition ${verdict} at step ${index}.`; break; }
        continue;
      }
      if (step.kind === "dom") {
        last = await session.actDom(window, observation, step.action, signal);
        issued = undefined;
        if (last.details.dom) { this.remember({ window_ref: window }, last); observation = last.details.observation_id!; issued = last; }
      } else {
        let element: string | undefined;
        if (index > 0 || step.target) {
          // Never reuse a stale observation: take a fresh UI walk and resolve the target in it.
          this.retireWindow(window);
          const fresh = this.remember({ window_ref: window }, await session.observeQuiet(window, signal));
          if (fresh.details.status !== "observed" || !fresh.details.ui) { last = fresh; rows.push({ index, action: String(step.command.action), outcome: "refused", reason: "No current UI sample." }); stop = `No current UI before step ${index}.`; break; }
          issued = fresh; observation = fresh.details.observation_id!;
          if (step.target) {
            const found = fresh.details.ui.elements.filter(item => (!step.target!.role || item.role?.toLowerCase() === step.target!.role.toLowerCase())
              && (!step.target!.name || item.name === step.target!.name) && (!step.target!.text || `${item.name ?? ""}\n${item.value ?? ""}`.includes(step.target!.text)));
            if (found.length !== 1) {
              rows.push({ index, action: String(step.command.action), outcome: "refused", reason: found.length ? `${found.length} elements match the target.` : "No element matches the target in the current UI walk." });
              stop = `Target not resolved at step ${index}; nothing was sent for it.`; break;
            }
            element = found[0].element_token;
          }
        }
        this.snapshots.delete(observation);
        issued = undefined;
        last = await session.act({ ...step.command, ...(element ? { element_token: element } : {}), window_ref: window, observation_id: observation } as Action, signal);
      }
      const outcome = last.details.status;
      rows.push({ index, action: step.kind === "dom" ? step.action.action : String(step.command.action), outcome,
        ...(outcome !== "delivered" ? { reason: computerResultText(last).split("\n{", 1)[0].slice(0, 300) } : {}) });
      if (outcome !== "delivered") { stop = `Step ${index} ${outcome}; later steps were not sent.`; break; }
    }
    const completed = rows.filter(row => row.outcome === "delivered" || row.verdict === "satisfied").length;
    const failed = rows.at(-1)?.outcome;
    // A stop at a condition leaves every sent action delivered; computerEffect marks a refusal after delivered steps as unknown.
    const status: ComputerResult["details"]["status"] = failed === "unknown" || failed === "refused" ? failed : "delivered";
    const message = `Batch ${stop ? "stopped" : "completed"}: ${completed}/${steps.length} steps in ${Math.round(performance.now() - started)} ms. ${stop || "Every action was delivered and every condition held."} Never replay completed or uncertain steps.`;
    // The current observation is whatever the last step left: a successor snapshot or verification sample.
    const base = issued ? issued.details : { ...last.details, dom: undefined, ui: undefined, observation_id: undefined, verification: undefined };
    const details = { ...base, status, ...(last.details.window_ref ? { window_ref: last.details.window_ref } : {}),
      batch: { total: steps.length, completed, stop_reason: stop, elapsed_ms: Math.round(performance.now() - started), steps: rows } };
    return { content: [{ type: "text", text: message }], details, ...(status === "delivered" ? {} : { isError: true }) };
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
