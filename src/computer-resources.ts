import { randomUUID } from "node:crypto";
import { parseComputerAddress, computerSource, type ComputerAddress } from "./computer-address.ts";
import { parseComputerViews, type ComputerViews } from "./computer-views.ts";
import { checkedName, type ProcessHealth } from "./machine-host.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import type { ComputerSession, ComputerResult, ComputerMode, Action } from "./session.ts";
import { parseWindowManagement, type WindowManagementCommand } from "./window-management.ts";
import { validateWebAction, validateWebLaunch, type WebAction } from "./web-browser.ts";
import { combine, evaluateNative, type WaitSpec } from "./ui-conditions.ts";
import { diffDom, diffUi } from "./successor.ts";
import type { UiElement, UiResource } from "./ui-resources.ts";
import { displayMode } from "./display-mode.ts";
import { isSemanticAction } from "./semantic-actions.ts";
import { accessibleName, ariaRole, checkedState, isVisible, nativeAriaSnapshot, nativeSelector, queryNative, suggestLocator, type ParsedSelector } from "./native-locator.ts";
import { SETUP_PARTS, SetupError, runSetup, type SetupPart } from "./setup.ts";

/** The machine this extension runs on, by its address name. */
export const LOCAL_MACHINE = "local";
/** How to use a machine address: the same on every machine. */
export function machineGuide(source: string): string[] {
  return [`Search ${source}/windows for its windows and ${source}/apps for its installed apps; Read ${source}/displays for its displays (Insert resize into a display address to change its resolution).`,
    `Insert open, open_browser, open_sandbox, open_session, webview2_debugging, put, get, files, clipboard_read, clipboard_write, record_start, record_stop, audio_record or close into ${source}.`];
}
/** A rejected request whose validation completed before native dispatch. */
export class ComputerRequestError extends Error {}
function commandObject(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)); }
  catch { throw new ComputerRequestError("Use one valid JSON command object."); }
}
/** Steps of one mixed batch; each native step after the first walks the UI again, so batches stay shorter than sequences. */
const BATCH_STEPS = 200;
/** Native actions a batch may run; each later step re-resolves its target in a fresh UI walk. */
const NATIVE_BATCH_ACTIONS = ["click", "double_click", "right_click", "type_text", "key", "hotkey", "scroll", "invoke", "select", "set_value"];
/** Native actions that take a Playwright locator or JSON target. */
const NATIVE_LOCATOR_ACTIONS = ["click", "double_click", "right_click", "hover", "type_text", "scroll", "invoke", "select", "set_value", "check", "uncheck"];
/** Playwright verbs with a different native name. */
const LOCATOR_VERBS: Record<string, string> = { fill: "set_value", dblclick: "double_click" };
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
  /** The machine whose Windows hosts this sandbox; undefined for this host. */
  machine?: string;
}
/** Start a Windows Sandbox for open_sandbox, or an isolated agent session for open_session; validation errors are reported before any host work. */
export type SandboxFactory = (cwd: string, command: Record<string, unknown>, signal?: AbortSignal, machine?: string) => Promise<OpenedSandbox>;
/** Another machine's desktop, driven over SSH by its own session. */
export interface OpenedMachine {
  /** Its configured name, which is also its address. */
  ref: string;
  session: ComputerSession;
  describe(source: string): string;
  /** Release the remote session and everything it started on that machine, reporting what was released. */
  close(): Promise<ComputerResult>;
}
/** Start a configured machine by name; unknown names refuse before any SSH work. */
export type MachineFactory = (cwd: string, name: string, signal?: AbortSignal) => Promise<OpenedMachine>;
const text = (result: ComputerResult) => result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
/** A cleanup that threw: what it released is unknown. */
const failure = (error: unknown, mode: ComputerMode): ComputerResult => ({ content: [{ type: "text", text: `Cleanup failed; what it released is unknown: ${error instanceof Error ? error.message : error}` }],
  details: { status: "unknown", mode } });
/** One result for a release of several parts, each with its own outcome; any unknown part leaves the whole release unknown. */
function report(mode: ComputerMode, parts: readonly (readonly [string | undefined, ComputerResult])[], heading?: string): ComputerResult {
  const unknown = parts.some(([, result]) => result.details.status === "unknown");
  // Keep each part's message, not the JSON projection a session appends after it: one result shows one message.
  const lines = parts.map(([source, result]) => (source ? `${source}: ` : "") + text(result).split("\n{", 1)[0]);
  return { content: [{ type: "text", text: [...(heading ? [heading] : []), ...lines].join("\n") }], details: { status: unknown ? "unknown" : "closed", mode } };
}
/**
 * The target of an open command: an installed app by name, or an executable by absolute Windows path with
 * up to 32 command-line arguments (YOLO only, checked by the session). debugging starts it with WebView2 remote
 * debugging in its environment.
 */
function openTarget(command: Record<string, unknown>, where: string): string | { path: string; args: string[]; debugging?: boolean } {
  if (command.path === undefined) {
    only(command, ["action", "app"]);
    if (typeof command.app !== "string" || !command.app.trim()) throw new ComputerRequestError(`Open needs an app name installed ${where}, or path and args.`);
    return command.app;
  }
  only(command, ["action", "path", "args", "debugging"]);
  if (command.debugging !== undefined && typeof command.debugging !== "boolean") throw new ComputerRequestError("debugging must be true or false.");
  if (typeof command.path !== "string" || !/^[A-Za-z]:\\.+\.exe$/i.test(command.path)) throw new ComputerRequestError("path must be an absolute Windows path to an .exe, for example C:\\Tools\\app.exe.");
  const args = command.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== "string" || arg.length > 8192)) throw new ComputerRequestError("args must be up to 32 strings.");
  return { path: command.path, args: args as string[], ...(command.debugging ? { debugging: true } : {}) };
}
const FILE_ACTIONS = ["put", "get", "files", "clipboard_read", "clipboard_write", "record_start", "record_stop", "audio_record"];
/** Speech in a WAV file as text, with faster-whisper run through uv on the agent's own machine. */
async function transcribe(wav: string): Promise<{ text: string; language: string; segments: { start: number; end: number; text: string }[] }> {
  const script = fileURLToPath(new URL("../scripts/transcribe.py", import.meta.url));
  const { stdout } = await promisify(execFile)("uv", ["run", "-q", "--with", "faster-whisper", "--with", "av<16", "python", script, wav], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
    .catch((error: Error) => { throw new ComputerRequestError(`Transcription failed (needs uv and network on first use): ${error.message.slice(0, 400)}`); });
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}
/**
 * Move files between the workspace and the session's own folder on the controlled machine, and use its clipboard.
 * put copies a workspace file in, get copies one out, files lists the folder; closing the session removes it.
 * clipboard_read/clipboard_write are explicit YOLO-only calls on the clipboard the user also uses.
 */
async function fileCommand(session: ComputerSession, command: Record<string, unknown>, cwd: string, mode: ComputerMode): Promise<ComputerResult> {
  if (!session.host) throw new ComputerRequestError("This desktop has no owned file folder.");
  const host = session.host;
  const local = (value: unknown, field: string) => {
    if (typeof value !== "string" || !value.trim()) throw new ComputerRequestError(`${command.action} needs ${field}: a workspace file path.`);
    return resolve(cwd, value);
  };
  const done = (text: string, state: Record<string, unknown>): ComputerResult => ({ content: [{ type: "text", text }], details: { status: "delivered", mode, state } });
  try {
    if (command.action === "clipboard_read") {
      only(command, ["action", "image"]);
      if (command.image !== undefined && typeof command.image !== "boolean") throw new ComputerRequestError("clipboard_read image must be true or false.");
      return await session.clipboardRead(command.image === true);
    }
    if (command.action === "clipboard_write") {
      only(command, ["action", "text", "image"]);
      if ((command.text === undefined) === (command.image === undefined)) throw new ComputerRequestError("clipboard_write needs exactly one of text or image (a workspace image path).");
      if (command.text !== undefined) {
        if (typeof command.text !== "string") throw new ComputerRequestError("clipboard_write text must be a string.");
        return await session.clipboardWrite({ text: command.text });
      }
      const from = local(command.image, "image");
      return await session.clipboardWrite({ imagePath: await host.put(checkedName(`clipboard-${basename(from)}`), await readFile(from)) });
    }
    if (command.action === "record_start") {
      only(command, ["action", "seconds"]);
      if (!Number.isSafeInteger(command.seconds) || (command.seconds as number) < 1 || (command.seconds as number) > 600) throw new ComputerRequestError("record_start needs seconds: 1..600.");
      return await session.recordStart(command.seconds as number);
    }
    if (command.action === "record_stop") {
      only(command, ["action", "to"]);
      const stopped = await session.recordStop();
      if (command.to === undefined || stopped.details.status !== "delivered") return stopped;
      const to = local(command.to, "to");
      const bytes = await host.get(String(stopped.details.state!.name));
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, bytes);
      return { ...stopped, content: [...stopped.content, { type: "text", text: `Fetched it (${bytes.length} bytes) into ${to}.` }] };
    }
    if (command.action === "audio_record") {
      only(command, ["action", "seconds", "to", "transcribe"]);
      if (!Number.isSafeInteger(command.seconds) || (command.seconds as number) < 1 || (command.seconds as number) > 300) throw new ComputerRequestError("audio_record needs seconds: 1..300.");
      if (command.transcribe !== undefined && typeof command.transcribe !== "boolean") throw new ComputerRequestError("transcribe must be true or false.");
      const recorded = await session.recordAudio(command.seconds as number);
      if (recorded.details.status !== "delivered") return recorded;
      const name = String(recorded.details.state!.name);
      const to = command.to === undefined ? undefined : local(command.to, "to");
      if (!to && !command.transcribe) return recorded;
      const bytes = await host.get(name);
      const wav = to ?? resolve(cwd, ".tmp", `pi-${name}`);
      await mkdir(dirname(wav), { recursive: true });
      await writeFile(wav, bytes);
      const lines = [...recorded.content, ...(to ? [{ type: "text" as const, text: `Fetched it (${bytes.length} bytes) into ${to}.` }] : [])];
      if (!command.transcribe) return { ...recorded, content: lines };
      const transcript = await transcribe(wav).finally(() => to ? undefined : rm(wav, { force: true }));
      return { ...recorded, content: [...lines, { type: "text", text: `Transcript (faster-whisper on this machine; can be wrong): ${transcript.text || "(no speech)"}` }],
        details: { ...recorded.details, state: { ...recorded.details.state, transcript } } };
    }
    if (command.action === "files") {
      only(command, ["action"]);
      const folder = await host.files();
      const files = await host.list();
      return done(`Session folder ${folder.windows}: ${files.length ? files.map(file => `${file.name} (${file.bytes} bytes)`).join(", ") : "empty"}. Apps on that machine can open and save files there.`, { folder: folder.windows, files });
    }
    if (command.action === "put") {
      only(command, ["action", "name", "from"]);
      const from = local(command.from, "from");
      const path = await host.put(checkedName(String(command.name ?? basename(from))), await readFile(from));
      return done(`Put ${from} as ${path}.`, { path });
    }
    only(command, ["action", "name", "to"]);
    const to = local(command.to, "to");
    const bytes = await host.get(checkedName(String(command.name)));
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, bytes);
    return done(`Got ${command.name} (${bytes.length} bytes) into ${to}.`, { path: to, bytes: bytes.length });
  } catch (error) {
    if (error instanceof ComputerRequestError) throw error;
    throw new ComputerRequestError(`File ${command.action} failed: ${error instanceof Error ? error.message : error}`);
  }
}
/** Install an optional part on a machine, or prepare another one from this machine; the user must have allowed it. */
async function setupCommand(command: Record<string, unknown>, machine: string | undefined, cwd: string, mode: ComputerMode, signal?: AbortSignal): Promise<ComputerResult> {
  only(command, ["action", "part", "ssh", "name", "code", "argv"]);
  const part = command.part;
  if (typeof part !== "string" || !SETUP_PARTS.some(item => item.name === part))
    throw new ComputerRequestError(`setup needs part: one of ${SETUP_PARTS.map(item => item.name).join(", ")}. Install only after the user explicitly allowed that part on that machine.`);
  const strings: Record<string, string> = {};
  for (const key of ["ssh", "name", "code", "argv"]) {
    if (command[key] === undefined) continue;
    if (typeof command[key] !== "string" || !command[key]) throw new ComputerRequestError(`setup ${key} must be a non-empty string.`);
    strings[key] = command[key] as string;
  }
  if (part === "machine" && machine) throw new ComputerRequestError("Prepare another machine from computer:machine/local.");
  if (part !== "machine" && (strings.ssh || strings.name)) throw new ComputerRequestError("ssh and name belong to setup part machine.");
  if (part !== "vscode-bridge" && (strings.code || strings.argv)) throw new ComputerRequestError("code and argv belong to setup part vscode-bridge.");
  try {
    const text = await runSetup({ part: part as SetupPart, ...(machine ? { machine } : {}), ...strings }, cwd, { ...(signal ? { signal } : {}) });
    return { content: [{ type: "text", text }], details: { status: "delivered", mode, state: { operation: "setup", part, machine: machine ?? LOCAL_MACHINE } } };
  } catch (error) {
    if (error instanceof SetupError) throw new ComputerRequestError(error.message);
    return { content: [{ type: "text", text: `Setup of ${part} failed: ${error instanceof Error ? error.message : error}` }],
      details: { status: "refused", mode, state: { operation: "setup", part, machine: machine ?? LOCAL_MACHINE } }, isError: true };
  }
}
const unresponsive = (health: ProcessHealth) => `The app ${health.name} (pid ${health.pid}) is not responding; it uses ${health.memory_mb} MB memory. Capture and input cannot recover a hung app: wait and read again, or close it.`;
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
  /** Each window's latest observed UI, the baseline of its next `changes` Read. Outlives the observation's input authority. */
  private readonly lastUi = new Map<string, { observation_id: string; ui: UiResource }>();
  /** Installed apps by opaque reference, each with the machine that listed it. */
  private readonly apps = new Map<string, { machine: string; id: string }>();
  private readonly sandboxes = new Map<string, OpenedSandbox>();
  /** Started remote machines by name. The local machine is the session getSession returns. */
  private readonly machines = new Map<string, OpenedMachine>();
  /** Remote machines still starting, so concurrent first uses share one start. */
  private readonly starting = new Map<string, Promise<OpenedMachine>>();
  /** Sandbox launches and machine starts still in progress; a cancelled one finishes its own cleanup before it settles. */
  private readonly opening = new Set<Promise<unknown>>();

  /** Give an installed app of one machine an opaque reference; paths themselves are not session references. */
  private appRef(machine: string, id: string): string {
    let ref = [...this.apps].find(([, app]) => app.machine === machine && app.id === id)?.[0];
    if (!ref) { ref = randomUUID(); this.apps.set(ref, { machine, id }); }
    return ref;
  }
  constructor(private readonly getSession: (cwd: string) => Promise<ComputerSession>,
    private readonly closeSession: () => Promise<ComputerResult>, private readonly openSandbox?: SandboxFactory,
    private readonly startMachine?: MachineFactory, private readonly getMode: () => ComputerMode = () => "yolo") {}

  /** The session that issued a window or display reference: a sandbox's or another machine's, otherwise this host's. */
  private async sessionFor(cwd: string, target?: ObservationTarget | { window_ref?: string; display?: string }): Promise<ComputerSession> {
    for (const environment of [...this.sandboxes.values(), ...this.machines.values()])
      if (target?.window_ref ? environment.session.hasWindow(target.window_ref) : target?.display && environment.session.hasDisplay(target.display)) return environment.session;
    return this.getSession(cwd);
  }
  private windowOf(address: ComputerAddress): { window_ref?: string; display?: string } | undefined {
    return address.kind === "window" ? { window_ref: address.ref }
      : address.kind === "display" ? { display: address.ref }
      : address.kind === "window-state" ? { window_ref: this.windowStates.get(address.ref)?.window_ref }
      : address.kind === "observation" ? this.snapshots.get(address.ref)?.target : undefined;
  }
  /** A configured remote machine, started on its first use. */
  private async machine(cwd: string, name: string, signal?: AbortSignal): Promise<OpenedMachine> {
    const open = this.machines.get(name);
    if (open) return open;
    if (!this.startMachine) throw new ComputerRequestError("Other machines are not available in this runtime.");
    let start = this.starting.get(name);
    if (!start) {
      start = this.launch(this.startMachine(cwd, name, signal), signal).then(machine => { this.machines.set(name, machine); return machine; })
        .finally(() => this.starting.delete(name));
      this.starting.set(name, start);
    }
    return start;
  }
  /** The session of a machine by name: this one's, or a remote one's started on first use. */
  private async machineSession(cwd: string, name: string, signal?: AbortSignal): Promise<ComputerSession> {
    return name === LOCAL_MACHINE ? this.getSession(cwd) : (await this.machine(cwd, name, signal)).session;
  }
  /** Forget a released session's observations and window states. */
  private forget(session: ComputerSession): void {
    for (const [id, entry] of this.snapshots)
      if (entry.target.window_ref ? session.hasWindow(entry.target.window_ref) : session.hasDisplay(entry.target.display!)) this.snapshots.delete(id);
    for (const [id, entry] of this.windowStates) if (session.hasWindow(entry.window_ref)) this.windowStates.delete(id);
  }
  /**
   * Release one machine: its sandboxes and sessions, then its own session with its browsers and file folder. The
   * result lists each released part and how its cleanup ended.
   */
  private async closeMachine(name: string): Promise<ComputerResult> {
    const sandboxes = [...this.sandboxes.values()].filter(sandbox => (sandbox.machine ?? LOCAL_MACHINE) === name);
    const parts = await Promise.all(sandboxes.map(sandbox => this.closeSandbox(sandbox).then(result => [computerSource("sandbox", sandbox.ref), result] as const,
      error => [computerSource("sandbox", sandbox.ref), failure(error, this.getMode())] as const)));
    let own: ComputerResult;
    if (name === LOCAL_MACHINE) {
      for (const [id, entry] of this.snapshots) if (!this.remoteOwner(entry.target)) this.snapshots.delete(id);
      for (const [id, entry] of this.windowStates) if (!this.remoteOwner({ window_ref: entry.window_ref })) this.windowStates.delete(id);
      own = await this.closeSession().catch(error => failure(error, this.getMode()));
    } else {
      const machine = this.machines.get(name);
      if (!machine) return report(this.getMode(), [], `${computerSource("machine", name)} was not started.`);
      this.machines.delete(name);
      this.forget(machine.session);
      own = await machine.close().catch(error => failure(error, this.getMode()));
    }
    for (const [ref, app] of this.apps) if (app.machine === name) this.apps.delete(ref);
    return report(this.getMode(), [...parts, [computerSource("machine", name), own]]);
  }
  /** Whether a remote machine or a sandbox issued this window or display reference. */
  private remoteOwner(target: { window_ref?: string; display?: string }): boolean {
    return [...this.sandboxes.values(), ...this.machines.values()].some(environment =>
      target.window_ref ? environment.session.hasWindow(target.window_ref) : target.display !== undefined && environment.session.hasDisplay(target.display));
  }
  /** Run one launch so session close and Pi shutdown can wait for it; a launch cancelled after success is undone. */
  private async launch<T extends { close(): Promise<unknown> }>(start: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.opening.add(start);
    let opened: T;
    try { opened = await start; } finally { this.opening.delete(start); }
    // Nobody will receive the address of something finished after cancellation, so undo it.
    if (signal?.aborted) { await opened.close(); throw new Error("Cancelled; nothing was kept."); }
    return opened;
  }
  private async startSandbox(cwd: string, command: Record<string, unknown>, signal?: AbortSignal, machine?: string): Promise<ComputerResult> {
    if (!this.openSandbox) throw new ComputerRequestError("Sandboxes are not available in this runtime.");
    const sandbox = await this.launch(this.openSandbox(cwd, command, signal, machine), signal);
    this.sandboxes.set(sandbox.ref, sandbox);
    const source = computerSource("sandbox", sandbox.ref);
    return { content: [{ type: "text", text: `${command.action === "open_session" ? "Isolated session" : "Sandbox"} ready: ${source}\n${sandbox.describe(source)}` }],
      details: { status: "delivered", mode: this.getMode(), sandbox_ref: sandbox.ref } };
  }
  private sandbox(ref: string): OpenedSandbox {
    const sandbox = this.sandboxes.get(ref);
    if (!sandbox) throw new ComputerRequestError("Sandbox reference expired. It was closed or this session was released.");
    return sandbox;
  }
  private async closeSandbox(sandbox: OpenedSandbox): Promise<ComputerResult> {
    this.sandboxes.delete(sandbox.ref);
    this.forget(sandbox.session);
    await sandbox.close();
    return { content: [{ type: "text", text: `Sandbox ${computerSource("sandbox", sandbox.ref)} destroyed. Its windows and observations are gone.` }],
      details: { status: "closed", mode: this.getMode(), sandbox_ref: sandbox.ref } };
  }
  /**
   * Release every machine, sandbox and isolated session this computer session started, the local machine included;
   * used by computer:session close and when Pi shuts down. The result lists each part and how its cleanup ended.
   */
  async closeAll(): Promise<ComputerResult> {
    await Promise.allSettled([...this.opening]);
    const names = [...new Set([...this.machines.keys(), ...[...this.sandboxes.values()].map(sandbox => sandbox.machine ?? LOCAL_MACHINE)])].filter(name => name !== LOCAL_MACHINE);
    const results = await Promise.all([...names.map(name => this.closeMachine(name)), this.closeMachine(LOCAL_MACHINE)]);
    this.snapshots.clear();
    this.windowStates.clear();
    this.apps.clear();
    return report(this.getMode(), results.map(result => [undefined, result]), "Computer use released. Application documents were not closed or saved.");
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
    if (target.window_ref !== undefined && result.details.ui) {
      this.lastUi.delete(target.window_ref);
      this.lastUi.set(target.window_ref, { observation_id: id, ui: result.details.ui });
      while (this.lastUi.size > 64) this.lastUi.delete(this.lastUi.keys().next().value!);
    }
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
    if (address.kind === "machine") {
      const remote = this.machines.get(address.ref);
      if (remote) return remote.describe(address.source);
      return [`# Machine ${address.ref}`, `Address: ${address.source}`, ...machineGuide(address.source)].join("\n");
    }
    if (address.kind === "session") {
      const machines = [LOCAL_MACHINE, ...this.machines.keys()].map(name => `- ${computerSource("machine", name)}`);
      const sandboxes = [...this.sandboxes.values()].map(sandbox => `- ${computerSource("sandbox", sandbox.ref)} on ${computerSource("machine", sandbox.machine ?? LOCAL_MACHINE)}`);
      return ["# Computer use", "Machines (computer:machine/local is this one; a machine configured under machines in .pi/computer-use.json starts on its first use):",
        ...machines, ...(sandboxes.length ? ["Sandboxes and isolated sessions:", ...sandboxes] : []),
        "Insert {\"action\":\"close\"} here to release every machine, browser, sandbox and session this computer use started; the result lists each part."].join("\n");
    }
    return `# Computer resource\nSource: ${address.source}\nUse Read for native observation, Search for discovery, and Insert for explicit commands. No native capture occurred during descriptor resolution.`;
  }

  /** Acquire a requested native projection, or inspect one explicitly issued observation. */
  async read(address: ComputerAddress, cwd: string, views?: readonly string[], signal?: AbortSignal): Promise<ComputerResult | undefined> {
    const view = parseComputerViews(views);
    if (address.kind !== "window" && address.kind !== "observation") {
      if (view.ocr) throw new ComputerRequestError("ocr reads a window, one of its observations or a region of one.");
      return this.readNative(address, cwd, views, view, signal);
    }
    const session = await this.sessionFor(cwd, this.windowOf(address));
    const snapshot = address.kind === "observation" ? this.snapshots.get(address.ref) : undefined;
    const windowRef = address.kind === "window" ? address.ref : snapshot?.target.window_ref;
    if (view.ocr && windowRef === undefined) throw new ComputerRequestError("ocr reads window observations; display observations have no kept overview pixels.");
    if (view.changes && address.kind !== "window") throw new ComputerRequestError("changes reads a window address: it takes a fresh UI walk and compares it with the window's previous observation.");
    const baseline = view.changes && windowRef !== undefined ? this.lastUi.get(windowRef) : undefined;
    const target = windowRef === undefined ? undefined : session.windowTarget(windowRef);
    if (view.regions && windowRef === undefined) throw new ComputerRequestError("regions reads a window or one of its observations.");
    // A region of a stored observation is read from its own pixels: exact boxes, no native call, input authority kept.
    const result = view.ocr && view.kind === "region" && snapshot && windowRef !== undefined
      ? await this.recognize(session, snapshot.result, windowRef, view.region, signal)
      // An observation keeps its own capture: regions parses it without another native read.
      : view.regions && snapshot ? snapshot.result
      : await this.readNative(address, cwd, views, view, signal);
    if (!result) return result;
    if (view.regions && result.details.status === "observed") {
      try { return { ...result, details: { ...result.details, visual_regions: await session.visualRegions(windowRef!, result.details.observation_id!, signal) } }; }
      catch (error) { throw new ComputerRequestError(`Visual region detection failed: ${error instanceof Error ? error.message : error}`); }
    }
    if (view.aria && result.details.status === "observed" && result.details.ui) {
      try { return { ...result, details: { ...result.details, aria: nativeAriaSnapshot(result.details.ui) } }; }
      catch (error) { throw new ComputerRequestError(`The aria snapshot could not be rendered: ${error instanceof Error ? error.message : error}`); }
    }
    if (view.changes && result.details.status === "observed" && result.details.ui) {
      const changes = baseline ? { since: baseline.observation_id, diff: diffUi(baseline.ui, result.details.ui) }
        : { reason: "No earlier UI observation of this window in this session, so this is the full UI." };
      return { ...result, details: { ...result.details, changes } };
    }
    if (view.kind === "state" && result.details.status === "observed") {
      const health = await session.processHealth(target);
      return health ? { ...result, content: [...result.content, { type: "text", text: health.responding ? `Process ${health.name} (pid ${health.pid}) responds; ${health.memory_mb} MB memory, ${health.cpu_seconds} s CPU.` : unresponsive(health) }], details: { ...result.details, process: health } } : result;
    }
    if (result.details.status === "refused" || result.details.status === "unknown") {
      const health = await session.processHealth(target);
      return health && !health.responding ? { ...result, content: [...result.content, { type: "text", text: unresponsive(health) }], details: { ...result.details, process: health } } : result;
    }
    return view.ocr && view.kind !== "region" && windowRef !== undefined ? this.recognize(session, result, windowRef, undefined, signal) : result;
  }

  /** Add Windows OCR lines of an observation's unannotated overview pixels, or of one region of them. */
  private async recognize(session: ComputerSession, result: ComputerResult, windowRef: string, region: { x: number; y: number; width: number; height: number } | undefined, signal?: AbortSignal): Promise<ComputerResult> {
    const id = result.details.observation_id;
    const image = id === undefined ? undefined : session.observationImage(windowRef, id);
    if (!image) throw new ComputerRequestError("This observation's unannotated pixels are no longer kept. Read the window with ocr again.");
    let lines;
    try { lines = await session.recognizeText(image, region, signal); }
    catch (error) { throw new ComputerRequestError(`Text recognition failed: ${error instanceof Error ? error.message : error}`); }
    const listing = lines.length ? lines.map(line => `- "${line.text}" at ${line.x},${line.y} ${line.width}x${line.height}`).join("\n") : "(no text found)";
    const header = `Windows OCR${region ? ` of region ${region.x},${region.y} ${region.width}x${region.height}` : ""}: ${lines.length} lines; boxes are in this observation's overview pixels. Recognised text can be wrong; confirm with pixels or UI before acting on it.`;
    return { ...result, content: [...(region ? [] : result.content), { type: "text", text: `${header}\n${listing}` }], details: { ...result.details, text_lines: lines } };
  }

  private async readNative(address: ComputerAddress, cwd: string, views: readonly string[] | undefined, view: ComputerViews, signal?: AbortSignal): Promise<ComputerResult | undefined> {
    if (address.kind === "machine") {
      if (views?.length) throw new ComputerRequestError("A machine address has no image views. Read a returned window or display address.");
      if (address.part === "windows" || address.part === "apps") throw new ComputerRequestError(`Search ${address.source} with a name or regex:<pattern>.`);
      const session = await this.machineSession(cwd, address.ref, signal);
      return address.part === "displays" ? session.displays(signal) : undefined;
    }
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
      if (view.kind !== "overview" || Object.keys(view.capture).some(key => key !== "maxLongEdge" && key !== "scale"))
        throw new ComputerRequestError("A display overview accepts only capture:{\"maxLongEdge\":...,\"scale\":...}; use its observation for region detail.");
      const { maxLongEdge, scale } = view.capture;
      return this.remember({ display: address.ref }, await session.observeDisplay(address.ref, signal, undefined,
        { ...(maxLongEdge !== undefined ? { maxLongEdge } : {}), ...(scale !== undefined ? { scale } : {}) }));
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
    if (address.kind === "machine") {
      if (address.part !== "windows" && address.part !== "apps")
        throw new ComputerRequestError(`Search ${computerSource("machine", address.ref, "windows")} or ${computerSource("machine", address.ref, "apps")}; Read ${computerSource("machine", address.ref, "displays")} for displays.`);
      const machine = await this.machineSession(cwd, address.ref, signal);
      if (address.part === "windows") return machine.windows(signal, query);
      const listed = await machine.apps(signal, query);
      const apps = listed.details.state?.apps;
      // Each app gets an address that opens it on the machine that listed it.
      return Array.isArray(apps) ? { ...listed, details: { ...listed.details, state: { ...listed.details.state,
        apps: apps.map(app => ({ ...app, app_ref: this.appRef(address.ref, String((app as { app_id: unknown }).app_id)) })) } } } : listed;
    }
    const session = await this.sessionFor(cwd, this.windowOf(address));
    if (address.kind !== "observation") throw new ComputerRequestError("Search computer:machine/<name>/windows, computer:machine/<name>/apps, a sandbox address or a returned observation address.");
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
      const session = await this.sessionFor(cwd, { window_ref: state.window_ref });
      return management ? session.manageWindow(state.window_ref, address.ref, management, signal)
        : session.restoreWindow(state.window_ref, address.ref, signal);
    }
    if (address.kind === "sandbox") {
      const sandbox = this.sandbox(address.ref);
      if (tool !== "insert") throw new ComputerRequestError("A sandbox address accepts Insert open or close, not literal Write.");
      const command = commandObject(value);
      if (command.action === "close") { only(command, ["action"]); return this.closeSandbox(sandbox); }
      if (command.action !== "open") throw new ComputerRequestError("A sandbox address accepts {\"action\":\"open\",\"app\":\"...\"} or {\"action\":\"close\"}.");
      const result = await sandbox.session.open(openTarget(command, "in the sandbox"), signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (address.kind === "machine") {
      if (tool !== "insert" || address.part) throw new ComputerRequestError(`Insert commands into ${computerSource("machine", address.ref)}, not literal Write or its windows, apps or displays.`);
      const command = commandObject(value);
      if (command.action === "close") { only(command, ["action"]); return this.closeMachine(address.ref); }
      const remote = address.ref === LOCAL_MACHINE ? undefined : address.ref;
      // Setup prepares a machine, so it must not start that machine's driver first.
      if (command.action === "setup") return setupCommand(command, remote, cwd, this.getMode(), signal);
      if (command.action === "open_sandbox" || command.action === "open_session") {
        // A remote machine starts before its sandbox, so an unknown name refuses first.
        if (remote) await this.machine(cwd, remote, signal);
        return this.startSandbox(cwd, command, signal, remote);
      }
      const session = await this.machineSession(cwd, address.ref, signal);
      if (FILE_ACTIONS.includes(command.action as string)) return fileCommand(session, command, cwd, this.getMode());
      if (command.action === "webview2_debugging") {
        only(command, ["action", "app", "enabled"]);
        if (typeof command.app !== "string" || !/^[^\\/:*?"<>|]{1,200}\.exe$/i.test(command.app)) throw new ComputerRequestError("webview2_debugging needs app: the app's executable file name, for example \"ms-teams.exe\".");
        if (typeof command.enabled !== "boolean") throw new ComputerRequestError("webview2_debugging needs enabled: true or false.");
        return session.webview2Debugging(command.app, command.enabled);
      }
      if (command.action === "open_browser") {
        let options;
        try { options = validateWebLaunch(command); }
        catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
        const result = await session.openBrowser(options, signal);
        return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
      }
      if (command.action !== "open")
        throw new ComputerRequestError(`A machine address accepts open, open_browser, open_sandbox, open_session, webview2_debugging, setup, ${FILE_ACTIONS.join(", ")} or close.`);
      const result = await session.open(openTarget(command, "on that machine"), signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (tool === "insert" && address.kind === "session") {
      const command = commandObject(value);
      if (command.action !== "close") throw new ComputerRequestError("computer:session accepts only close. Insert machine commands into computer:machine/local or computer:machine/<name>.");
      only(command, ["action"]);
      return this.closeAll();
    }
    if (tool === "insert" && address.kind === "app") {
      only(commandObject(value), ["action"]);
      const app = this.apps.get(address.ref);
      if (!app) throw new ComputerRequestError("App reference expired. Search computer:machine/<name>/apps again.");
      const result = await (await this.machineSession(cwd, app.machine, signal)).open(app.id, signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (address.kind === "display" && tool === "insert") {
      const command = commandObject(value);
      if (command.action !== "resize") throw new ComputerRequestError("A display address accepts only resize. Read it for pixels.");
      only(command, ["action", "width", "height"]);
      let mode;
      try { mode = displayMode(command); }
      catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
      const session = await this.sessionFor(cwd, { display: address.ref });
      // Window and display coordinates from before the change no longer hold. Collect them now:
      // a successful change also retires the display references used to recognize them.
      const stale = [...this.snapshots].filter(([, entry]) => entry.target.window_ref ? session.hasWindow(entry.target.window_ref) : session.hasDisplay(entry.target.display!)).map(([id]) => id);
      const result = await session.resizeDisplay(address.ref, mode, signal);
      if (result.details.status !== "refused") { for (const id of stale) this.snapshots.delete(id); this.forget(session); }
      return result;
    }
    if (address.kind === "window" && tool === "insert") {
      const command = commandObject(value);
      const session = await this.sessionFor(cwd, { window_ref: address.ref });
      if (command.action === "kill") {
        only(command, ["action"]);
        this.retireWindow(address.ref);
        return session.killOwned(address.ref, signal);
      }
      if (command.action === "attach_browser") {
        only(command, ["action"]);
        return session.attachBrowser(address.ref, signal);
      }
      if (command.target !== undefined && command.action !== "wait_for" && command.action !== "verify") {
        if (session.isBrowserWindow(address.ref)) throw new ComputerRequestError("For a browser window, Read it with dom and Insert the action into that DOM observation; Playwright resolves the target there.");
        return this.locatorAction(address.ref, session, command, signal);
      }
      if (command.action !== "wait_for" && command.action !== "verify")
        throw new ComputerRequestError("A window address accepts an action with a target (a Playwright locator such as getByRole(\"button\", { name: \"Save\" })), wait_for, verify, attach_browser or kill. Other input needs the observation address returned by a fresh window Read.");
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
          const session = await this.sessionFor(cwd, { window_ref: window });
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
      if (command.target !== undefined && !snapshot.result.details.dom) {
        if (address.hint !== undefined) throw new ComputerRequestError("Choose the address hint or a JSON target, not both.");
        this.snapshots.delete(address.ref);
        const result = await this.locatorAction(window, await this.sessionFor(cwd, { window_ref: window }), command, signal);
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
      const result = await (await this.sessionFor(cwd, snapshot.target)).actDom(snapshot.target.window_ref, address.ref, command, signal);
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
    // The address delivery is a preference for pointer and keyboard input. Semantic actions always use accessibility.
    if (address.delivery !== undefined && !isSemanticAction(String(command.action))) {
      if ("delivery_mode" in command) throw new ComputerRequestError("Choose delivery in the address or JSON, not both.");
      command.delivery_mode = address.delivery;
    }
    const action = { ...command, window_ref: snapshot.target.window_ref, observation_id: address.ref } as Action;
    const session = await this.sessionFor(cwd, snapshot.target);
    let result = await session.act(action, signal);
    // Delivered pixel-only input keeps the observation usable; anything else, including a refusal, spends it.
    if (result.details.status !== "delivered" || !session.holdsObservation(snapshot.target.window_ref!, address.ref)) this.snapshots.delete(address.ref);
    // Windows refused to activate the target: say who holds the foreground, so a blocked desktop is not mistaken for a bad target.
    if (/foreground_unavailable/.test(JSON.stringify(result.details.state ?? {})) && session.host) {
      const owner = await session.host.foregroundOwner().catch(() => undefined);
      if (owner) result = { ...result, content: [...result.content, { type: "text", text:
        `Windows kept the foreground on ${owner.name} (pid ${owner.pid}). If that is not a window this task opened (for example a system service after a UAC prompt), Windows also blocks injected input there until a person clicks or presses a key on that machine: ask the user to do that, then Read again.` }] };
    }
    return result;
  }

  /** Validate an action's optional `expect` postcondition and `successor` request before anything is dispatched. */
  private async followUpSpec(window: string, command: Record<string, unknown>, cwd: string): Promise<FollowUp> {
    if (command.successor !== undefined && typeof command.successor !== "boolean") throw new ComputerRequestError("successor must be boolean.");
    let expect: WaitSpec | undefined;
    if (command.expect !== undefined) {
      const raw = command.expect;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ComputerRequestError("expect must be an object with conditions and optional timeout_ms, interval_ms and stable.");
      try { expect = (await this.sessionFor(cwd, { window_ref: window })).waitSpec(window, { ...raw as Record<string, unknown>, action: "wait_for" }); }
      catch (error) { throw new ComputerRequestError(`expect: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return { ...(expect ? { expect } : {}), successor: command.successor === true || expect !== undefined };
  }

  /**
   * After an action, wait for its declared postcondition and attach the successor observation with a compact
   * diff from the action's input observation. A refused or unknown action never yields a verified postcondition.
   */
  private async followUp(window: string, before: Snapshot, result: ComputerResult, follow: FollowUp, cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    const session = await this.sessionFor(cwd, { window_ref: window });
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
   * Resolve a Playwright locator the way Playwright's actions do: take fresh UI walks until exactly one element
   * matches and is ready (enabled for input; for pointer input at the same place in two walks; on screen for hover), or
   * until the timeout. Several matches refuse at once with each match's locator, like Playwright's strict mode.
   */
  private async resolveNative(window: string, session: ComputerSession, selector: ParsedSelector, options: { timeout_ms: number; enabled: boolean; stable: boolean; visible?: boolean; describe: string }, signal?: AbortSignal):
    Promise<{ element: UiElement; observation: ComputerResult } | { refused: string; observation?: ComputerResult }> {
    const deadline = performance.now() + options.timeout_ms;
    let previous: UiElement | undefined, reason = "";
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) return { refused: "Cancelled while waiting for the target; nothing was sent." };
      this.retireWindow(window);
      const fresh = this.remember({ window_ref: window }, await session.observeQuiet(window, signal));
      if (fresh.details.status !== "observed" || !fresh.details.ui) return { refused: `No current UI sample of the window: ${computerResultText(fresh).split("\n")[0]}`, observation: fresh };
      const ui = fresh.details.ui;
      let found: UiElement[];
      try { found = queryNative(ui, selector); }
      catch (error) { return { refused: error instanceof Error ? error.message : String(error), observation: fresh }; }
      if (found.length > 1) {
        const listed = found.slice(0, 8).map(item => `  ${item.hint} ${ariaRole(item)} ${JSON.stringify(accessibleName(item))} → ${suggestLocator(item)}`).join("\n");
        return { refused: `Strict mode: ${options.describe} matches ${found.length} elements; nothing was sent. Narrow it, for example with exact, filter or nth:\n${listed}${found.length > 8 ? `\n  …and ${found.length - 8} more` : ""}`, observation: fresh };
      }
      const element = found[0];
      if (!element) reason = ui.complete === true && !ui.truncated ? "no element matches it" : "no element matches it in the walked part of the window (the UI walk was incomplete)";
      else if (options.visible && !isVisible(element)) reason = "the element is not visible (offscreen)";
      else if (options.enabled && element.enabled === false) reason = "the element is disabled";
      else if (options.stable && previous && JSON.stringify(previous.bounds.native_screen) !== JSON.stringify(element.bounds.native_screen)) reason = "the element is still moving";
      else if (!options.stable || previous || !element.bounds.native_screen) return { element, observation: fresh };
      else reason = "the element is still moving";
      previous = element && accessibleName(element) === accessibleName(previous ?? element) ? element : undefined;
      const left = deadline - performance.now();
      if (left <= 0) return { refused: `Timed out after ${options.timeout_ms} ms waiting for ${options.describe}: ${reason}. Nothing was sent.`, observation: fresh };
      await new Promise(resolve => setTimeout(resolve, Math.min(left, [0, 20, 50, 100, 100, 250][attempt] ?? 500)));
    }
  }

  /**
   * One native action addressed by a Playwright locator or JSON target, without a prior Read: resolve it in a fresh
   * walk with auto-waiting, then act on that element. `check`/`uncheck` act only when the state differs and confirm it.
   */
  private async locatorAction(window: string, session: ComputerSession, command: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerResult> {
    const { target, timeout_ms: timeout, ...rest } = command;
    let selector: ParsedSelector;
    try { selector = nativeSelector(target); }
    catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || (timeout as number) < 0 || (timeout as number) > 60_000)) throw new ComputerRequestError("timeout_ms must be an integer 0..60000.");
    if (["hint", "element_token", "x", "y", "window_ref", "observation_id"].some(key => key in rest)) throw new ComputerRequestError("Choose target or a hint, token or pixels, not both.");
    const verb = String(rest.action);
    const action = LOCATOR_VERBS[verb] ?? verb;
    if (!NATIVE_LOCATOR_ACTIONS.includes(action)) throw new ComputerRequestError(`A target takes one of ${[...NATIVE_LOCATOR_ACTIONS, ...Object.keys(LOCATOR_VERBS)].join(", ")}.`);
    const describe = typeof target === "string" ? target : JSON.stringify(target);
    const pointer = ["click", "double_click", "right_click", "hover", "check", "uncheck"].includes(action);
    const resolved = await this.resolveNative(window, session, selector, { timeout_ms: (timeout as number | undefined) ?? 5_000, enabled: action !== "hover", stable: pointer, visible: action === "hover", describe }, signal);
    const mode = this.getMode();
    if ("refused" in resolved) return { content: [{ type: "text", text: resolved.refused }], details: { status: "refused", mode, window_ref: window }, isError: true };
    const { element, observation } = resolved;
    const named = `${ariaRole(element)} ${JSON.stringify(accessibleName(element))} (${suggestLocator(element)})`;
    const done = (status: "delivered" | "unknown", text: string): ComputerResult => ({ content: [{ type: "text", text }], details: { status, mode, window_ref: window }, ...(status === "delivered" ? {} : { isError: true }) });
    if (action === "check" || action === "uncheck") {
      const want = action === "check", state = checkedState(element);
      if (state === null) return { content: [{ type: "text", text: `${named} reports no checked state; ${action} needs a checkbox, radio or toggle. Nothing was sent.` }], details: { status: "refused", mode, window_ref: window }, isError: true };
      if (state === want) return done("delivered", `${named} is already ${want ? "checked" : "unchecked"}; nothing was sent.`);
    }
    const nativeCommand = { ...rest, action: action === "check" || action === "uncheck" ? "click" : action, element_token: element.element_token,
      window_ref: window, observation_id: observation.details.observation_id };
    this.snapshots.delete(observation.details.observation_id!);
    const result = await session.act(nativeCommand as Action, signal);
    const prefix = { type: "text" as const, text: `Target ${describe} resolved to ${named}.` };
    if ((action !== "check" && action !== "uncheck") || result.details.status !== "delivered") return { ...result, content: [prefix, ...result.content] };
    // Like Playwright's check(): confirm the new state, and say so when the app did not change it.
    const after = await this.resolveNative(window, session, selector, { timeout_ms: 2_000, enabled: false, stable: false, describe }, signal);
    const state = "element" in after ? checkedState(after.element) : null;
    return state === (action === "check") ? { ...result, content: [prefix, ...result.content, { type: "text", text: `It is now ${action}ed.` }] }
      : done("unknown", `${prefix.text} The click was delivered, but the element is ${state === null ? "no longer readable" : state === "mixed" ? "mixed" : state ? "checked" : "unchecked"} afterwards. Read the window before deciding; do not replay blindly.`);
  }

  /**
   * Run up to 16 known steps in one call and stop at the first step that is not delivered or satisfied.
   * Browser steps are Playwright actions and conditions. Native steps resolve `target` (a Playwright locator or
   * JSON target) in fresh UI walks with auto-waiting; only the first step may use a hint or pixels of the current observation.
   */
  private async batch(address: Extract<ComputerAddress, { kind: "observation" }>, snapshot: Snapshot, command: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    only(command, ["action", "steps"]);
    const window = snapshot.target.window_ref!;
    if (address.hint !== undefined || address.delivery !== undefined || address.delayMs !== undefined) throw new ComputerRequestError("A batch takes its targets and delivery from its steps, not the address.");
    if (!Array.isArray(command.steps) || command.steps.length < 1 || command.steps.length > BATCH_STEPS) throw new ComputerRequestError(`batch needs steps: 1..${BATCH_STEPS} step objects.`);
    const session = await this.sessionFor(cwd, { window_ref: window });
    const browser = snapshot.result.details.dom !== undefined;
    type Step = { kind: "wait"; spec: WaitSpec; action: string } | { kind: "dom"; action: WebAction } | { kind: "native"; command: Record<string, unknown>; target?: ParsedSelector; describe?: string; timeout?: number };
    const steps: Step[] = command.steps.map((raw, index): Step => {
      const step = object(raw);
      const label = `steps[${index}]`;
      try {
        if (step.action === "wait_for" || step.action === "verify") return { kind: "wait", spec: session.waitSpec(window, step), action: String(step.action) };
        if (browser) return { kind: "dom", action: validateWebAction(step) };
        if (typeof step.action === "string" && LOCATOR_VERBS[step.action]) step.action = LOCATOR_VERBS[step.action];
        if (!NATIVE_BATCH_ACTIONS.includes(String(step.action))) throw Error(`action must be one of ${NATIVE_BATCH_ACTIONS.join(", ")}, wait_for or verify.`);
        if (["window_ref", "observation_id", "sequence"].some(key => key in step)) throw Error("identity fields and nested sequences are not allowed.");
        const pinned = ["hint", "element_token", "x", "y"].some(key => key in step);
        if (pinned && index > 0) throw Error("only the first step may use a hint, token or pixels; later steps use a target (a Playwright locator or JSON target).");
        let target: ParsedSelector | undefined;
        if (step.target !== undefined) {
          if (pinned) throw Error("choose target or a hint/pixel target, not both.");
          target = nativeSelector(step.target);
        }
        const timeout = step.timeout_ms;
        if (timeout !== undefined && (!Number.isSafeInteger(timeout) || (timeout as number) < 0 || (timeout as number) > 60_000)) throw Error("timeout_ms must be an integer 0..60000.");
        const { target: raw, timeout_ms: _timeout, ...nativeStep } = step;
        return { kind: "native", command: nativeStep, ...(target ? { target, describe: typeof raw === "string" ? raw : JSON.stringify(raw), timeout: (timeout as number | undefined) ?? 5_000 } : {}) };
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
          // Never reuse a stale observation: a target resolves in fresh UI walks; other steps take one fresh walk.
          if (step.target) {
            const action = String(step.command.action), pointer = ["click", "double_click", "right_click"].includes(action);
            const resolved = await this.resolveNative(window, session, step.target, { timeout_ms: step.timeout!, enabled: true, stable: pointer, describe: step.describe! }, signal);
            if ("refused" in resolved) {
              if (resolved.observation) last = resolved.observation;
              rows.push({ index, action, outcome: "refused", reason: resolved.refused.slice(0, 600) });
              stop = `Target not resolved at step ${index}; nothing was sent for it.`; break;
            }
            issued = resolved.observation; observation = resolved.observation.details.observation_id!;
            element = resolved.element.element_token;
          } else {
            this.retireWindow(window);
            const fresh = this.remember({ window_ref: window }, await session.observeQuiet(window, signal));
            if (fresh.details.status !== "observed" || !fresh.details.ui) { last = fresh; rows.push({ index, action: String(step.command.action), outcome: "refused", reason: "No current UI sample." }); stop = `No current UI before step ${index}.`; break; }
            issued = fresh; observation = fresh.details.observation_id!;
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
