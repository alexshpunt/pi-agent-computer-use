import { randomUUID } from "node:crypto";
import { parseComputerAddress, computerSource, displaySource, viewportSource, ADDRESS_KINDS, NAME, type ComputerAddress } from "./computer-address.ts";
import { clipViewport, pngSize, viewportImage, viewportImageSize, viewportPoint, viewportRect, windowPoint, VIEWPORT_CAP, type Viewport } from "./viewport.ts";
import { FULL_RESOLUTION } from "./cua-image-settings.ts";
import { WATCH_DEFAULTS } from "./watch.ts";
import type { PixelBox } from "./pixel-diff.ts";
import { ShortAddresses, SHORT_REFERENCE } from "./short-addresses.ts";
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
import { compareCaptures, diffDom, diffIsEmpty, diffUi, type Capture, type StateDiff } from "./successor.ts";
import { changeCrops, changeOverview, decodeFrame, diffFrames, MOST_CHANGED, type DiffContext } from "./pixel-diff.ts";
import type { WindowFrame } from "./session.ts";
import { webContentTop, type UiCaptureOptions, type UiElement, type UiResource } from "./ui-resources.ts";
import { displayMode } from "./display-mode.ts";
import { isSemanticAction } from "./semantic-actions.ts";
import { accessibleName, ariaRole, checkedState, isVisible, nativeAriaSnapshot, nativeSelector, queryNative, suggestLocator, type ParsedSelector } from "./native-locator.ts";

/** The machine this extension runs on, by its address name. */
export const LOCAL_MACHINE = "local";
/** How to use a machine address: the same on every machine. */
export function machineGuide(source: string): string[] {
  return [`Search ${source}/windows for its windows and ${source}/apps for its installed apps; Read ${source}/displays for its displays and ${source}/display/primary for its main display (computer_display changes its resolution).`,
    `Give ${source} to computer_open, computer_files, computer_clipboard and computer_record; Delete it to release it.`];
}
/** A rejected request whose validation completed before native dispatch. */
export class ComputerRequestError extends Error {}
/**
 * The images that show a diff's pixel change, recorded on the diff: when most of the window changed, the whole window
 * after the action; otherwise an overview of the window with the listed areas outlined and numbered, then a before and
 * an after crop of each of the first areas.
 */
async function cropImages(before: Buffer, after: Buffer, diff: StateDiff): Promise<ComputerResult["content"]> {
  const pixels = diff.pixels;
  if (!pixels?.box || pixels.size_changed) return [];
  const image = (png: Buffer) => ({ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" });
  // A navigation replaces the page even when the old and new pages look alike, so it gets the whole page too.
  if (pixels.share >= MOST_CHANGED || diff.page?.url) {
    pixels.full = true;
    if (diff.page?.url) pixels.navigated = true;
    return [image(after)];
  }
  const [overview, cropped] = await Promise.all([changeOverview(after, pixels).catch(() => undefined), changeCrops(before, after, pixels).catch(() => [])]);
  if (overview) pixels.overview = true;
  pixels.crops = cropped.map(item => ({ ...item.region, scale: item.scale }));
  return [...(overview ? [image(overview)] : []), ...cropped.flatMap(item => [image(item.before), image(item.after)])];
}
/** Detail of a rectangle of a window comes from a viewport; a display observation keeps its region view. */
const WINDOW_REGION = "A window has no region view: make a viewport of that rectangle with computer_view, which shows it at the window's own resolution. Read the viewport, add ocr for its text, and act at points of its image.";
/** Web content up to this far above its topmost element still counts as page, for the page's own margin. */
const PAGE_MARGIN = 12;
/**
 * What a pixel comparison of a window knows about the action: its input point in the input observation's pixels,
 * and in a browser window where its web page starts, so changes wholly above it count as browser chrome. A window
 * whose web content starts in its upper half is treated as a browser; an app with a web view lower down is not.
 */
function diffContext(ui: UiResource | undefined, image: { width: number; height: number } | undefined, focus: InputPoint | undefined): DiffContext {
  const top = webContentTop(ui);
  const start = top === undefined ? undefined : Math.max(0, top - PAGE_MARGIN);
  const page = image && start !== undefined && start > 0 && start < image.height / 2 ? { x: 0, y: start, width: image.width, height: image.height - start } : undefined;
  return { ...(focus ? { focus } : {}), ...(page ? { page } : {}) };
}
/**
 * Where an input command lands in its observation's pixels: the end of a drag, the last pointed event of a timeline,
 * its point, or the centre of its ref. Undefined for input without a place, such as keys to the focused element.
 */
function inputFocus(command: Record<string, unknown>, ui: UiResource | undefined, hint: string | undefined): InputPoint | undefined {
  const point = (x: unknown, y: unknown) => typeof x === "number" && typeof y === "number" ? { x, y } : undefined;
  const events = Array.isArray(command.events) ? (command.events as { x?: unknown; y?: unknown }[]).filter(event => point(event.x, event.y)) : [];
  const box = hint ? ui?.elements.find(element => element.hint === hint)?.bounds.window_image : undefined;
  return point(command.to_x, command.to_y) ?? (events.length ? point(events.at(-1)!.x, events.at(-1)!.y) : undefined) ?? point(command.x, command.y)
    ?? (box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : undefined);
}
function commandObject(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)); }
  catch { throw new ComputerRequestError("Use one valid JSON command object."); }
}

/** Native actions that take a Playwright locator or JSON target. */
const NATIVE_LOCATOR_ACTIONS = ["click", "double_click", "right_click", "hover", "type_text", "key", "hotkey", "scroll", "invoke", "select", "set_value", "check", "uncheck"];
/** A point in pixels of a window's latest image, or in CSS pixels of a browser page. */
export interface InputPoint { x: number; y: number }
/** One typed input on a window, built by a computer_* input tool; the window decides which backend runs it. */
export interface InputPlan {
  /** The tool's action for refusals, such as click. */
  label: string;
  /** A ref of the window's latest Read (a native ref such as 1:a, a page ref such as e12) or a Playwright locator. */
  target?: string;
  point?: InputPoint;
  /** drag: where it ends. */
  end?: { target?: string; point?: InputPoint };
  /** Browser windows: page (CSS pixels of the page, the default) or window (pixels of the window's latest image). */
  space?: "page" | "window";
  /** The native command without its target, or why native windows cannot run it. */
  native: Record<string, unknown> | string;
  /** The Playwright action without its target, or why browser pages cannot run it. */
  web: Record<string, unknown> | string;
  /** Internal: send real input, after UI Automation could not carry the action on its target. */
  real?: boolean;
  /** Runs after this one is delivered, such as Enter after typing. */
  then?: InputPlan;
}
/** Native actions a target carries through UI Automation: a click runs the element's Invoke, Toggle, SelectionItem or ExpandCollapse pattern, a scroll its scroll pattern. */
const STRUCTURAL = ["click", "check", "uncheck", "scroll"];
/** Native actions that only a locator target runs; a ref of the latest Read becomes the locator of its element. */
const LOCATOR_ONLY = ["check", "uncheck"];
/** What a target string is: a native ref of a window Read (1:a), a page ref of a DOM Read (e12, f1e3), or a Playwright locator. */
export function refKind(target: unknown): "hint" | "page" | "locator" | undefined {
  if (typeof target !== "string") return undefined;
  return /^[0-9a-z]+:[a-z]+$/.test(target) ? "hint" : /^(?:f\d+)?e\d+$/.test(target) ? "page" : "locator";
}
/** Playwright verbs with a different native name. */
const LOCATOR_VERBS: Record<string, string> = { fill: "set_value", dblclick: "double_click" };
/**
 * What follows an action: the successor with its change list. `explicit` overrides the defaults that skip it.
 * `frame` holds the window's pixels before the action, when the input observation had them.
 */
interface FollowUp { successor: boolean; explicit: boolean; frame?: WindowFrame;
  /** Where the input landed, in the input observation's pixels; the pixel change list puts areas near it first. */
  focus?: InputPoint;
  /** A Playwright screenshot of the page before a page action, in CSS pixels, for its pixel change list. */
  page?: Buffer;
  /** The window's session, resolved before the action: a failed action can make the session forget the window. */
  session?: ComputerSession;
  /** The viewport the input went to, in the window's full-resolution pixels: the pixel comparison covers only it. */
  viewport?: PixelBox }
/** How long a native successor keeps looking for a change before reporting that nothing changed. */
const SETTLE_MS = 300;
/**
 * How long a native successor waits for a changing window to show two identical captures in a row. The captures
 * follow each other without a pause: each takes about 35 ms, so an animation still differs between them.
 */
const STEADY_MS = 1_000;
/** What an observation shows: a window, or one machine's display (display references are per machine; each has a primary). */
type ObservationTarget = { window_ref: string; display?: never; machine?: never } | { display: string; machine: string; window_ref?: never };
/** Whether an observation is a page's DOM snapshot or a native capture of a window or display. */
const observationKind = (result: ComputerResult) => result.details.dom ? "dom" : "native";
const sameTarget = (a: ObservationTarget, b: ObservationTarget) => a.window_ref === b.window_ref && a.display === b.display && a.machine === b.machine;
/** Where a request runs: the session that issued its reference, with that session's machine and sandbox. */
interface Owner { session: ComputerSession; machine: string; sandbox?: string }
/** The machine and sandbox a receipt names. */
type Place = { machine: string; sandbox?: string };
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
/** Browser operations that need no element of a snapshot: computer_browser runs them on a browser window. */
export const PAGE_ACTIONS = ["navigate", "back", "forward", "reload", "wait_load", "new_tab", "switch_tab", "close_tab", "dialog", "upload", "wait_download", "cancel_download", "evaluate"];
/** The Delete option that kills the process of a hung window the session opened instead of asking it to close. */
export const FORCE = "?force=true";
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
  // A session result's text is its summary, then its native JSON; added lines join the summary so every receipt shows them.
  const said = (result: ComputerResult, ...lines: string[]): ComputerResult => {
    const [first, ...rest] = result.content;
    if (first?.type !== "text") return { ...result, content: [...lines.map(line => ({ type: "text" as const, text: line })), ...result.content] };
    const cut = first.text.indexOf("\n{");
    const summary = cut < 0 ? first.text : first.text.slice(0, cut);
    return { ...result, content: [{ ...first, text: [summary, ...lines].join("\n") + (cut < 0 ? "" : first.text.slice(cut)) }, ...rest] };
  };
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
      return said(stopped, `Fetched it (${bytes.length} bytes) into ${to}.`);
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
      const fetched = to ? [`Fetched it (${bytes.length} bytes) into ${to}.`] : [];
      if (!command.transcribe) return said(recorded, ...fetched);
      const transcript = await transcribe(wav).finally(() => to ? undefined : rm(wav, { force: true }));
      const heard = said(recorded, ...fetched, `Transcript (faster-whisper on this machine; can be wrong): ${transcript.text || "(no speech)"}`);
      return { ...heard, details: { ...heard.details, state: { ...heard.details.state, transcript } } };
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
  /** Short aliases of this run's long addresses (computer:zinpc/w3qk). */
  private readonly shorts = new ShortAddresses();
  /** Window names the agent gave, with the window's title when it was named. */
  private readonly names = new Map<string, { window_ref: string; title: string }>();
  /** Window titles from the latest window listings, for naming by title and for listing names. */
  private readonly titles = new Map<string, string>();
  /** Viewports the agent made, by their long address (computer:window/<ref>/<name>). */
  private readonly viewports = new Map<string, Viewport>();
  /** This machine's session once started; reference checks need it synchronously. */
  private local?: ComputerSession;

  /** Give an installed app of one machine an opaque reference; paths themselves are not session references. */
  private appRef(machine: string, id: string): string {
    let ref = [...this.apps].find(([, app]) => app.machine === machine && app.id === id)?.[0];
    if (!ref) { ref = randomUUID(); this.apps.set(ref, { machine, id }); }
    return ref;
  }
  constructor(private readonly getSession: (cwd: string) => Promise<ComputerSession>,
    private readonly closeSession: () => Promise<ComputerResult>, private readonly openSandbox?: SandboxFactory,
    private readonly startMachine?: MachineFactory, private readonly getMode: () => ComputerMode = () => "yolo") {}

  /**
   * The session that issued a reference, with its machine. Nothing falls back to this machine: a reference that no
   * session of this computer use holds is refused before anything is sent.
   */
  private async owner(cwd: string, holds: (session: ComputerSession) => boolean, unknown: string): Promise<Owner> {
    for (const sandbox of this.sandboxes.values())
      if (holds(sandbox.session)) return { session: sandbox.session, machine: sandbox.machine ?? LOCAL_MACHINE, sandbox: sandbox.ref };
    for (const [machine, opened] of this.machines) if (holds(opened.session)) return { session: opened.session, machine };
    const local = this.local = await this.getSession(cwd);
    if (holds(local)) return { session: local, machine: LOCAL_MACHINE };
    throw new ComputerRequestError(`${unknown} No machine or sandbox of this computer use holds it, so nothing was sent.`);
  }
  /** Whether any started session of this computer use still holds a window reference. */
  private holdsWindow(ref: string): boolean {
    return [...this.sandboxes.values(), ...this.machines.values()].some(environment => environment.session.hasWindow(ref)) || !!this.local?.hasWindow(ref);
  }
  /** Give a window a name; one name per window, and a name of a live window is not taken over. */
  private nameWindow(name: unknown, ref: string): ComputerResult {
    if (typeof name !== "string" || !NAME.test(name) || ADDRESS_KINDS.has(name) || name === LOCAL_MACHINE || this.machines.has(name))
      throw new ComputerRequestError("as is a name of 1-32 lowercase letters, digits, - or _ that starts with a letter and is not an address word (session, window, machine, ...) or a machine name.");
    const held = this.names.get(name);
    if (held && held.window_ref !== ref && this.holdsWindow(held.window_ref))
      throw new ComputerRequestError(`computer:${name} already names ${computerSource("window", held.window_ref)}${held.title ? ` (${held.title})` : ""}. Choose another name.`);
    for (const [other, entry] of this.names) if (entry.window_ref === ref) this.names.delete(other);
    const title = this.titles.get(ref) ?? "";
    this.names.set(name, { window_ref: ref, title });
    return { content: [{ type: "text", text: `computer:${name} now names ${computerSource("window", ref)}${title ? ` (${title})` : ""}. Use it wherever this window's address goes; it stops resolving when the window closes.` }],
      details: { status: "delivered", mode: this.getMode(), window_ref: ref } };
  }
  /**
   * Parse an address the agent sent: a long one, a short alias issued in this run (computer:zinpc/w3qk, with the
   * observation options of the long form), or a window name (computer:game). Stale aliases and names refuse.
   */
  address(source: string): ComputerAddress {
    if (!source.startsWith("computer:")) return requireComputerAddress(source);
    const at = source.indexOf("?");
    const base = at < 0 ? source : source.slice(0, at), query = at < 0 ? "" : source.slice(at);
    const segments = base.slice(9).split("/");
    if (segments.length === 1 && !ADDRESS_KINDS.has(segments[0]) && NAME.test(segments[0])) {
      if (query) throw new ComputerRequestError("A window name takes no options.");
      const entry = this.names.get(segments[0]);
      if (!entry) throw new ComputerRequestError(`No window is named ${segments[0]}. Name a window with computer_window name first; Read computer:session for the current names.`);
      if (!this.holdsWindow(entry.window_ref)) {
        this.names.delete(segments[0]);
        throw new ComputerRequestError(`computer:${segments[0]} named a window that has closed or was released${entry.title ? ` (${entry.title})` : ""}. Search the machine's windows again and name the new one.`);
      }
      return requireComputerAddress(computerSource("window", entry.window_ref));
    }
    // A viewport of a named window: computer:game/pano. Window names never take a machine's name.
    if (segments.length === 2 && this.names.has(segments[0])) {
      if (query) throw new ComputerRequestError("A viewport address takes no options.");
      // Resolving the name refuses a window that has closed.
      this.address(`computer:${segments[0]}`);
      if (!NAME.test(segments[1])) throw new ComputerRequestError("A viewport name is 1-32 lowercase letters, digits, - or _ and starts with a letter.");
      return requireComputerAddress(viewportSource(this.names.get(segments[0])!.window_ref, segments[1]));
    }
    // A short window address, or a viewport of one: computer:zinpc/w3qk or computer:zinpc/w3qk/pano.
    if ((segments.length === 2 || segments.length === 3) && !ADDRESS_KINDS.has(segments[0]) && SHORT_REFERENCE.test(segments[1])) {
      let long: string;
      try { long = this.shorts.resolve(segments[0], segments[1]); }
      catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
      if (segments.length === 3 && (query || !long.startsWith("computer:window/"))) throw new ComputerRequestError("Only a window address takes a viewport name after it.");
      return requireComputerAddress(long + (segments.length === 3 ? `/${segments[2]}` : query));
    }
    return requireComputerAddress(source);
  }
  /** Replace the long addresses in text shown to the agent with this run's short aliases. */
  shorten(text: string): string {
    return this.shorts.shorten(text, (kind, ref) => this.place(requireComputerAddress(computerSource(kind, ref)))?.machine);
  }
  /** The owner of a window, or of one machine's display. */
  private async route(cwd: string, target: ObservationTarget, signal?: AbortSignal): Promise<Owner> {
    if (target.window_ref !== undefined)
      return this.owner(cwd, session => session.hasWindow(target.window_ref), "Unknown or closed window reference. Search computer:machine/<name>/windows again.");
    // That machine's session refuses a display reference it did not list, after its own mode check, without native work.
    return { session: await this.machineSession(cwd, target.machine, signal), machine: target.machine };
  }
  /** The owner of a window, display, observation or sequence address. */
  private async routeAddress(cwd: string, address: ComputerAddress, signal?: AbortSignal): Promise<Owner> {
    if (address.kind === "window" || address.kind === "viewport") return this.route(cwd, { window_ref: address.ref }, signal);
    if (address.kind === "display") return this.route(cwd, { display: address.ref, machine: address.machine }, signal);
    if (address.kind === "observation") return this.route(cwd, this.snapshot(address.ref).target, signal);
    if (address.kind === "sequence")
      return this.owner(cwd, session => session.hasSequence(address.ref), "Sequence is unavailable or evicted. Capture again; sequences do not survive reload or close.");
    throw new ComputerRequestError("This address names no window, display, observation or sequence.");
  }
  /** The machine and sandbox an address runs on, found without starting anything; none for the whole session. */
  private place(address: ComputerAddress): Place | undefined {
    const holder = (holds: (session: ComputerSession) => boolean): Place => {
      for (const sandbox of this.sandboxes.values()) if (holds(sandbox.session)) return { machine: sandbox.machine ?? LOCAL_MACHINE, sandbox: sandbox.ref };
      for (const [machine, opened] of this.machines) if (holds(opened.session)) return { machine };
      return { machine: LOCAL_MACHINE };
    };
    switch (address.kind) {
      case "session": return undefined;
      case "machine": return { machine: address.ref };
      case "display": return { machine: address.machine };
      case "app": { const app = this.apps.get(address.ref); return app && { machine: app.machine }; }
      case "sandbox": { const sandbox = this.sandboxes.get(address.ref); return sandbox && { machine: sandbox.machine ?? LOCAL_MACHINE, sandbox: sandbox.ref }; }
      case "sequence": return holder(session => session.hasSequence(address.ref));
      case "window": case "viewport": return holder(session => session.hasWindow(address.ref));
      case "observation": {
        const target = this.snapshots.get(address.ref)?.target;
        return !target ? undefined : target.machine !== undefined ? { machine: target.machine } : holder(session => session.hasWindow(target.window_ref!));
      }
    }
  }
  /** Name the machine (and sandbox) a request ran on in its receipt. */
  private stamp(place: Place | undefined, result: ComputerResult): ComputerResult {
    return place && result.details.machine === undefined
      ? { ...result, details: { ...result.details, machine: place.machine, ...(place.sandbox ? { sandbox: place.sandbox } : {}) } } : result;
  }
  /** The session of a window, or of one machine's display. */
  private async sessionFor(cwd: string, target: ObservationTarget, signal?: AbortSignal): Promise<ComputerSession> {
    return (await this.route(cwd, target, signal)).session;
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
    return name === LOCAL_MACHINE ? (this.local = await this.getSession(cwd)) : (await this.machine(cwd, name, signal)).session;
  }
  /** Forget a released session's observations, and the display observations of its machine. */
  private forget(session: ComputerSession, machine?: string): void {
    for (const [id, entry] of this.snapshots)
      if (entry.target.window_ref !== undefined ? session.hasWindow(entry.target.window_ref) : entry.target.machine === machine) this.snapshots.delete(id);
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
      for (const [id, entry] of this.snapshots)
        if (entry.target.window_ref !== undefined ? !this.remoteWindow(entry.target.window_ref) : entry.target.machine === LOCAL_MACHINE) this.snapshots.delete(id);
      own = await this.closeSession().catch(error => failure(error, this.getMode()));
    } else {
      const machine = this.machines.get(name);
      if (!machine) return report(this.getMode(), [], `${computerSource("machine", name)} was not started.`);
      this.machines.delete(name);
      this.forget(machine.session, name);
      own = await machine.close().catch(error => failure(error, this.getMode()));
    }
    for (const [ref, app] of this.apps) if (app.machine === name) this.apps.delete(ref);
    return report(this.getMode(), [...parts, [computerSource("machine", name), own]]);
  }
  /** Whether a remote machine or a sandbox issued this window reference. */
  private remoteWindow(ref: string): boolean {
    return [...this.sandboxes.values(), ...this.machines.values()].some(environment => environment.session.hasWindow(ref));
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
    this.apps.clear();
    return report(this.getMode(), results.map(result => [undefined, result]), "Computer use released. Application documents were not closed or saved.");
  }

  private snapshot(id: string): Snapshot {
    const entry = this.snapshots.get(id);
    if (!entry) throw new ComputerRequestError("Observation reference expired. Read a new window/display overview.");
    return entry;
  }
  /** Forget a window's observations: all of them, or only its DOM snapshots or only its native captures, which a Read of the other kind keeps. */
  private retireWindow(ref: string, kind?: "dom" | "native"): void {
    for (const [id, entry] of this.snapshots) if (entry.target.window_ref === ref && (!kind || observationKind(entry.result) === kind)) this.snapshots.delete(id);
  }
  private remember(target: ObservationTarget, result: ComputerResult): ComputerResult {
    const id = result.details.observation_id ?? result.details.agent_image?.image_id;
    // A delivered DOM action carries the page's next snapshot, which becomes the current observation.
    const observed = result.details.status === "observed" || result.details.status === "delivered" && result.details.dom !== undefined;
    if (!observed || typeof id !== "string") return result;
    // A window keeps one DOM snapshot and one native capture: a new one replaces only the earlier one of its kind.
    for (const [old, entry] of this.snapshots) if (sameTarget(entry.target, target) && observationKind(entry.result) === observationKind(result)) this.snapshots.delete(old);
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

  /** Whether an observation address is still current for input. Other addresses grant none. */
  grantsAuthority(address: ComputerAddress): boolean {
    return address.kind === "observation" && this.snapshots.has(address.ref);
  }
  /** Resolve an editor's readonly descriptor without native acquisition or target refresh. */
  descriptor(address: ComputerAddress): string {
    if (address.kind === "observation") {
      const snapshot = this.snapshot(address.ref);
      const source = snapshot.target.window_ref !== undefined ? computerSource("window", snapshot.target.window_ref)
        : displaySource(snapshot.target.machine!, snapshot.target.display!);
      return `# Computer observation\nSource: ${source}\nObservation: ${computerSource("observation", address.ref)}\n` +
        (snapshot.result.details.dom ? "Playwright DOM snapshot. Its refs are targets for the computer_* input tools on its window; Read element:crop|highlight,<ref> or image for page pixels. Search filters this snapshot."
          : snapshot.target.window_ref !== undefined ? "Its refs are targets for the computer_* input tools on its window until input spends them."
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
      // Names whose window closed disappear from the list and stop resolving.
      for (const [name, entry] of this.names) if (!this.holdsWindow(entry.window_ref)) this.names.delete(name);
      const names = [...this.names].map(([name, entry]) => `- computer:${name} → ${computerSource("window", entry.window_ref)}${entry.title ? ` | ${entry.title}` : ""}`);
      for (const [key, viewport] of this.viewports) if (!this.holdsWindow(viewport.window_ref)) this.viewports.delete(key);
      const viewports = [...this.viewports.values()].map(viewport => `- ${viewportSource(viewport.window_ref, viewport.name)}: ${viewport.rect.width}x${viewport.rect.height} at ${viewport.rect.x},${viewport.rect.y} in full-resolution window pixels`);
      const windows = [...this.titles].filter(([ref]) => this.holdsWindow(ref) && this.shorts.issued(computerSource("window", ref)))
        .map(([ref, title]) => `- ${computerSource("window", ref)} | ${title}`);
      const sandboxes = [...this.sandboxes.values()].map(sandbox => `- ${computerSource("sandbox", sandbox.ref)} on ${computerSource("machine", sandbox.machine ?? LOCAL_MACHINE)}`);
      return ["# Computer use", "Machines (computer:machine/local is this one; a machine configured under machines in .pi/computer-use.json starts on its first use). Every window, display, observation and sequence address belongs to the machine that issued it, and every receipt names that machine:",
        ...machines, ...(sandboxes.length ? ["Sandboxes and isolated sessions:", ...sandboxes] : []),
        ...(names.length ? ["Window names (computer_window name adds one):", ...names] : []),
        ...(viewports.length ? ["Viewports (computer_view makes, moves and resizes them; Delete removes one):", ...viewports] : []),
        ...(windows.length ? ["Windows listed so far:", ...windows] : []),
        "Delete this address to release every machine, browser, sandbox and session this computer use started; the result lists each part."].join("\n");
    }
    return `# Computer resource\nSource: ${address.source}\nUse Read to look, Search to discover, and the computer_* tools to act. No native capture occurred during descriptor resolution.`;
  }

  /** Acquire a requested native projection, or inspect one explicitly issued observation; the receipt names its machine. */
  async read(address: ComputerAddress, cwd: string, views?: readonly string[], signal?: AbortSignal): Promise<ComputerResult | undefined> {
    if (parseComputerViews(views).kind === "sequence") throw new ComputerRequestError("Read only looks; capture frames over time with computer_record action sequence.");
    return this.look(address, cwd, views, signal);
  }
  /** Capture frames of a window or display over time for computer_record; the sequence address then takes frame Reads. */
  sequence(address: ComputerAddress, cwd: string, views: readonly string[], signal?: AbortSignal): Promise<ComputerResult | undefined> {
    if (parseComputerViews(views).kind !== "sequence") throw new ComputerRequestError("computer_record sequence takes sequence options only.");
    return this.look(address, cwd, views, signal);
  }
  private async look(address: ComputerAddress, cwd: string, views?: readonly string[], signal?: AbortSignal): Promise<ComputerResult | undefined> {
    const place = this.place(address);
    const result = await this.readAddress(address, cwd, views, signal);
    return result && this.stamp(place, result);
  }
  private async readAddress(address: ComputerAddress, cwd: string, views?: readonly string[], signal?: AbortSignal): Promise<ComputerResult | undefined> {
    if (address.kind === "viewport") return this.readViewport(address, cwd, views, signal);
    const view = parseComputerViews(views);
    if (address.kind !== "window" && address.kind !== "observation") {
      if (view.ocr) throw new ComputerRequestError("ocr reads a window, one of its observations or a viewport.");
      return this.readNative(address, cwd, views, view, signal);
    }
    const snapshot = address.kind === "observation" ? this.snapshots.get(address.ref) : undefined;
    const windowRef = address.kind === "window" ? address.ref : snapshot?.target.window_ref;
    if (view.kind === "region" && windowRef !== undefined) throw new ComputerRequestError(WINDOW_REGION);
    if (view.ocr && windowRef === undefined) throw new ComputerRequestError("ocr reads window observations; display observations have no kept overview pixels.");
    if (view.changes && address.kind !== "window") throw new ComputerRequestError("changes reads a window address: it takes a fresh capture and compares it with the window's previous observation.");
    const session = (await this.routeAddress(cwd, address, signal)).session;
    const baseline = view.changes && windowRef !== undefined ? this.lastUi.get(windowRef) : undefined;
    // The pixel baseline is the window's latest capture with pixels; the fresh capture keeps its overview size.
    const frame = view.changes && windowRef !== undefined && view.kind === "overview" && view.capture.granularity !== "ui" ? session.windowFrame(windowRef) : undefined;
    if (frame && view.kind === "overview" && view.capture.maxLongEdge === undefined && view.capture.scale === undefined) Object.assign(view.capture, frame.size);
    const target = windowRef === undefined ? undefined : session.windowTarget(windowRef);
    if (view.regions && windowRef === undefined) throw new ComputerRequestError("regions reads a window or one of its observations.");
    // An observation keeps its own capture: regions parses it without another native read.
    let result = view.regions && snapshot ? snapshot.result
      : await this.readNative(address, cwd, views, view, signal);
    // A window whose pixels cannot be captured still lists its UI changes, unless pixels were asked for explicitly.
    if (view.changes && view.kind === "overview" && result && result.details.status !== "observed" && !views?.some(item => item === "full" || item === "image"))
      result = await this.readNative(address, cwd, views, { ...view, capture: { ...view.capture, granularity: "ui" } }, signal);
    if (!result) return result;
    if (view.regions && result.details.status === "observed") {
      try { return { ...result, details: { ...result.details, visual_regions: await session.visualRegions(windowRef!, result.details.observation_id!, signal) } }; }
      catch (error) { throw new ComputerRequestError(`Visual region detection failed: ${error instanceof Error ? error.message : error}`); }
    }
    if (view.aria && result.details.status === "observed" && result.details.ui) {
      try { return { ...result, details: { ...result.details, aria: nativeAriaSnapshot(result.details.ui) } }; }
      catch (error) { throw new ComputerRequestError(`The aria snapshot could not be rendered: ${error instanceof Error ? error.message : error}`); }
    }
    if (view.changes && result.details.status === "observed") {
      const captured = session.windowFrame(windowRef!);
      const latest = frame && captured?.observation_id === result.details.observation_id ? captured : undefined;
      const earlier = latest ? await decodeFrame(frame!.png) : undefined;
      const diff = compareCaptures({ ui: baseline?.ui, frame: earlier }, { ui: result.details.ui, frame: latest ? await decodeFrame(latest.png) : undefined },
        diffContext(result.details.ui, earlier, undefined));
      if (!diff) return { ...result, details: { ...result.details, changes: { reason: "No earlier observation of this window in this session to compare with, so this is the full observation." } } };
      const since = baseline?.observation_id ?? frame!.observation_id;
      if (diff.pixels && frame!.observation_id !== since) diff.pixels.since = frame!.observation_id;
      // The change list replaces the full overview: only crops of the changed area are shown.
      const crops = latest ? await cropImages(frame!.png, latest.png, diff) : [];
      return { ...result, content: [...result.content.filter(block => block.type !== "image"), ...crops], details: { ...result.details, changes: { since, diff } } };
    }
    if (view.kind === "state" && result.details.status === "observed") {
      const health = await session.processHealth(target);
      return health ? { ...result, content: [...result.content, { type: "text", text: health.responding ? `Process ${health.name} (pid ${health.pid}) responds; ${health.memory_mb} MB memory, ${health.cpu_seconds} s CPU.` : unresponsive(health) }], details: { ...result.details, process: health } } : result;
    }
    if (result.details.status === "refused" || result.details.status === "unknown") {
      const health = await session.processHealth(target);
      return health && !health.responding ? { ...result, content: [...result.content, { type: "text", text: unresponsive(health) }], details: { ...result.details, process: health } } : result;
    }
    return view.ocr && windowRef !== undefined ? this.recognize(session, result, windowRef, signal) : result;
  }

  /** Add Windows OCR lines of an observation's unannotated overview pixels. */
  private async recognize(session: ComputerSession, result: ComputerResult, windowRef: string, signal?: AbortSignal): Promise<ComputerResult> {
    const id = result.details.observation_id;
    const image = id === undefined ? undefined : session.observationImage(windowRef, id);
    if (!image) throw new ComputerRequestError("This observation's unannotated pixels are no longer kept. Read the window with ocr again.");
    let lines;
    try { lines = await session.recognizeText(image, undefined, signal); }
    catch (error) { throw new ComputerRequestError(`Text recognition failed: ${error instanceof Error ? error.message : error}`); }
    const listing = lines.length ? lines.map(line => `- "${line.text}" at ${line.x},${line.y} ${line.width}x${line.height}`).join("\n") : "(no text found)";
    const header = `Windows OCR: ${lines.length} lines; boxes are in this observation's overview pixels. Recognised text can be wrong; confirm with pixels or UI before acting on it.`;
    return { ...result, content: [...result.content, { type: "text", text: `${header}\n${listing}` }], details: { ...result.details, text_lines: lines } };
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
    const owner = await this.routeAddress(cwd, address, signal);
    const session = owner.session;
    if (view.kind === "sequence") {
      if (address.kind !== "window" && address.kind !== "display") throw new ComputerRequestError("Capture a sequence from a window/display address, not an observation.");
      if (owner.sandbox) throw new ComputerRequestError("Temporal capture is not available for sandbox windows.");
      const target: ObservationTarget = address.kind === "display" ? { display: address.ref, machine: address.machine } : { window_ref: address.ref };
      for (const [id, entry] of this.snapshots) if (sameTarget(entry.target, target)) this.snapshots.delete(id);
      return session.captureSequence(address.kind === "window" ? { window_ref: address.ref } : { display: address.ref }, view.options, signal);
    }
    if (address.kind === "sequence") {
      if (view.kind !== "frames") throw new ComputerRequestError("Select sequence images explicitly with frames:first|last|endpoints|changed|all or frames:{\"indexes\":[0]}; add \"as\":\"sheet\" for one tiled image.");
      return session.sequenceFrames(address.ref, view.selection, signal, view.rendering);
    }
    if (view.kind === "frames") throw new ComputerRequestError("Frame selection needs a sequence address.");
    if (address.kind === "window") {
      // A fresh window Read retires the earlier observation of its kind; a DOM snapshot and a native capture coexist.
      // A state Read only looks and keeps the window's observations; computer_window samples its own state for each change.
      if (view.kind === "state") return session.observeWindowState(address.ref, signal);
      this.retireWindow(address.ref, view.kind === "dom" ? "dom" : "native");
      if (view.kind === "dom") return this.remember({ window_ref: address.ref }, await session.observeDom(address.ref, view.options, signal));
      if (view.kind !== "overview") throw new ComputerRequestError("Read an overview of the window, then element views on its returned observation address.");
      return this.remember({ window_ref: address.ref }, await session.observe(address.ref, signal, undefined, undefined, undefined, view.capture));
    }
    if (address.kind === "display") {
      if (view.kind !== "overview" || Object.keys(view.capture).some(key => key !== "maxLongEdge" && key !== "scale"))
        throw new ComputerRequestError("A display overview accepts only capture:{\"maxLongEdge\":...,\"scale\":...}; use its observation for region detail.");
      const { maxLongEdge, scale } = view.capture;
      return this.remember({ display: address.ref, machine: address.machine }, await session.observeDisplay(address.ref, signal, undefined,
        { ...(maxLongEdge !== undefined ? { maxLongEdge } : {}), ...(scale !== undefined ? { scale } : {}) }));
    }
    if (address.kind !== "observation") throw new ComputerRequestError("Use an existing supported computer resource.");
    const snapshot = this.snapshot(address.ref);
    if (snapshot.result.details.dom) {
      const ref = snapshot.target.window_ref;
      if (!ref) throw new ComputerRequestError("Readonly DOM requires a window source.");
      if (view.kind === "element") {
        if (view.operation !== "crop" && view.operation !== "highlight") throw new ComputerRequestError("A DOM observation supports element:crop|highlight,<aria ref>. Use dom:{\"target\":...} for a scoped snapshot.");
        return session.webImage(ref, address.ref, view.operation, { ref: view.hint }, signal);
      }
      if (view.kind === "dom" && Object.keys(view.options).length) {
        this.retireWindow(ref, "dom");
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
      if (snapshot.target.window_ref !== undefined) throw new ComputerRequestError(WINDOW_REGION);
      // Retire the provider handle even when detail refuses; never turn detail into an input target.
      this.snapshots.delete(address.ref);
      const imageId = snapshot.result.details.agent_image?.image_id;
      if (typeof imageId !== "string") throw new ComputerRequestError("This observation has no image for detail.");
      return session.observeDisplay(snapshot.target.display!, signal, { image_id: imageId, ...view.region });
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

  /** Search permitted discovery metadata or the current collected UI without another native walk; the receipt names its machine. */
  async search(address: ComputerAddress, cwd: string, query: string, limit?: number, signal?: AbortSignal): Promise<ComputerResult> {
    const result = await this.searchAt(address, cwd, query, limit, signal);
    const windows = result.details.state?.windows;
    if (Array.isArray(windows)) {
      const listed = new Set<string>();
      for (const row of windows as { window_ref?: unknown; title?: unknown; name?: unknown }[])
        if (typeof row.window_ref === "string") { listed.add(row.window_ref); this.titles.set(row.window_ref, String(row.title ?? row.name ?? "")); }
      // A full listing shows every open window of that machine or sandbox: windows missing from it have closed,
      // and their names and titles go. The native session keeps such references until a capture finds them gone.
      const where = this.place(address);
      const same = (ref: string) => { const other = this.place(requireComputerAddress(computerSource("window", ref))); return other?.machine === where?.machine && other?.sandbox === where?.sandbox; };
      if (!query && result.details.status === "listed" && where) {
        for (const ref of this.titles.keys()) if (!listed.has(ref) && same(ref)) this.titles.delete(ref);
        for (const [name, entry] of this.names) if (!listed.has(entry.window_ref) && same(entry.window_ref)) this.names.delete(name);
      }
    }
    while (this.titles.size > 512) this.titles.delete(this.titles.keys().next().value!);
    return result;
  }
  private async searchAt(address: ComputerAddress, cwd: string, query: string, limit?: number, signal?: AbortSignal): Promise<ComputerResult> {
    const place = this.place(address);
    return this.stamp(place, await this.searchAddress(address, cwd, query, limit, signal));
  }
  private async searchAddress(address: ComputerAddress, cwd: string, query: string, limit?: number, signal?: AbortSignal): Promise<ComputerResult> {
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
    if (address.kind !== "observation") throw new ComputerRequestError("Search computer:machine/<name>/windows, computer:machine/<name>/apps, a sandbox address or a returned observation address.");
    const session = (await this.routeAddress(cwd, address, signal)).session;
    const snapshot = this.snapshot(address.ref);
    if (!snapshot.target.window_ref) throw new ComputerRequestError("Display images have no native UI search scope.");
    if (snapshot.result.details.dom) return session.searchDom(snapshot.target.window_ref, address.ref, query, limit, signal);
    return session.observe(snapshot.target.window_ref, signal, undefined, undefined,
      { operation: "search", observation_id: address.ref, query, ...(limit !== undefined ? { limit } : {}) });
  }

  /**
   * Close what an address names: a window (like its close button; `?force=true` kills the hung process of a window
   * this session opened), a sandbox or isolated session, a machine, or computer:session. The receipt names its machine.
   */
  async delete(source: string, cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    const force = source.endsWith(FORCE);
    const address = this.address(force ? source.slice(0, -FORCE.length) : source);
    if (force && address.kind !== "window") throw new ComputerRequestError("?force=true applies to window addresses only.");
    return this.stamp(this.place(address), await this.deleteAt(address, cwd, force, signal));
  }
  private async deleteAt(address: ComputerAddress, cwd: string, force: boolean, signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind === "window") {
      const session = await this.sessionFor(cwd, { window_ref: address.ref }, signal);
      this.retireWindow(address.ref);
      return force ? session.killOwned(address.ref, signal) : session.closeWindow(address.ref, signal);
    }
    if (address.kind === "sandbox") return this.closeSandbox(this.sandbox(address.ref));
    if (address.kind === "machine" && !address.part) return this.closeMachine(address.ref);
    if (address.kind === "session") return this.closeAll();
    if (address.kind === "viewport") {
      const viewport = this.viewport(address);
      this.viewports.delete(viewportSource(viewport.window_ref, viewport.name));
      return { content: [{ type: "text", text: `Removed ${viewportSource(viewport.window_ref, viewport.name)}; its window stays open.` }], details: { status: "closed", mode: this.getMode(), window_ref: viewport.window_ref } };
    }
    throw new ComputerRequestError("Delete closes a window, a sandbox or isolated session, a machine or computer:session, or removes a viewport. Observations, sequences, apps and displays need no closing.");
  }
  /** Name a window by its address, so computer:<name> resolves to it until it closes. The receipt names its machine. */
  async name(address: ComputerAddress, cwd: string, name: unknown, signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind !== "window") throw new ComputerRequestError("computer_window needs a window address from Search, Read or a name.");
    const place = this.place(address);
    await this.route(cwd, { window_ref: address.ref }, signal);
    return this.stamp(place, this.nameWindow(name, address.ref));
  }
  /** A viewport the agent made; refused when it was never made or its window has closed. */
  private viewport(address: Extract<ComputerAddress, { kind: "viewport" }>): Viewport {
    const source = viewportSource(address.ref, address.name);
    if (!this.holdsWindow(address.ref)) {
      for (const [key, viewport] of this.viewports) if (viewport.window_ref === address.ref) this.viewports.delete(key);
      throw new ComputerRequestError(`The window of ${source} has closed or was released. Search its machine's windows again.`);
    }
    const viewport = this.viewports.get(source);
    if (!viewport) throw new ComputerRequestError(`${source} is no viewport yet. Make it with computer_view and x, y, width and height in pixels of the window's latest image.`);
    return viewport;
  }
  /** Full-resolution pixels per pixel of the window's latest image the agent saw, on each axis; 1 before any image. */
  private imageScale(session: ComputerSession, window: string, full: { width: number; height: number }) {
    const seen = session.inputView(window).seen;
    return seen ? { x: full.width / seen.width, y: full.height / seen.height } : { x: 1, y: 1 };
  }
  /** The PNG of a full-resolution window capture. */
  private static pixels(captured: ComputerResult): Buffer | undefined {
    const image = captured.details.status === "observed" ? captured.content.find(block => block.type === "image") : undefined;
    return image?.type === "image" ? Buffer.from(image.data, "base64") : undefined;
  }
  /** The details that name a viewport in a receipt: its address, its window, its rectangle and the size of its image. */
  private static viewportDetails(viewport: Viewport, clipped: PixelBox): NonNullable<ComputerResult["details"]["viewport"]> {
    return { source: viewportSource(viewport.window_ref, viewport.name), name: viewport.name, window_ref: viewport.window_ref, rect: clipped, image: viewportImageSize(clipped) };
  }
  /** A viewport's image cut from a full-resolution window capture, with where it lies in the window's latest image. */
  private async showViewport(viewport: Viewport, clipped: PixelBox, png: Buffer, captured: ComputerResult, scale: { x: number; y: number }, note = ""): Promise<ComputerResult> {
    const image = await viewportImage(png, clipped), details = ComputerResources.viewportDetails(viewport, clipped), size = details.image;
    const shown = { x: Math.round(clipped.x / scale.x), y: Math.round(clipped.y / scale.y), width: Math.round(clipped.width / scale.x), height: Math.round(clipped.height / scale.y) };
    const text = `${details.source} is ${shown.width}x${shown.height} at ${shown.x},${shown.y} of the window's latest image. Its image is ${size.width}x${size.height}` +
      (size.width === clipped.width ? ", the window's own resolution." : `: ${clipped.width}x${clipped.height} window pixels scaled down to fit ${VIEWPORT_CAP} px.`) +
      ` Points of the computer_* input tools on ${details.source} are pixels of this image.${note}`;
    return { content: [{ type: "text", text }, { type: "image", data: image.toString("base64"), mimeType: "image/png" }],
      details: { ...captured.details, status: "observed", viewport: details } };
  }
  /**
   * Make, move or resize a viewport of a window and show it. The rectangle is in pixels of the window's latest image,
   * like points of the input tools; fields left out keep the viewport's current ones. The receipt names its machine.
   */
  async view(address: ComputerAddress, cwd: string, given: Partial<PixelBox>, signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind !== "viewport")
      throw new ComputerRequestError("computer_view needs a viewport address: computer:<window name>/<viewport name> such as computer:game/pano, or a window address with the viewport name after it such as computer:zinpc/w3qk/pano.");
    const existing = this.viewports.get(viewportSource(address.ref, address.name));
    if (existing) this.viewport(address);
    const place = this.place(address);
    const session = await this.sessionFor(cwd, { window_ref: address.ref }, signal);
    const captured = await session.windowPixels(address.ref, signal);
    const png = ComputerResources.pixels(captured);
    if (!png) return this.stamp(place, captured);
    const full = await pngSize(png), scale = this.imageScale(session, address.ref, full);
    let rect: PixelBox;
    try { rect = viewportRect(given, scale, existing?.rect); }
    catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    const clipped = clipViewport(rect, full);
    if (!clipped) throw new ComputerRequestError(`That rectangle lies outside the window: its latest image is ${Math.round(full.width / scale.x)}x${Math.round(full.height / scale.y)}.`);
    const viewport: Viewport = { window_ref: address.ref, name: address.name, rect: clipped };
    this.viewports.set(viewportSource(address.ref, address.name), viewport);
    const unseen = session.inputView(address.ref).seen ? "" : " The window had no Read with an image yet, so the rectangle was taken in its full-resolution pixels.";
    return this.stamp(place, await this.showViewport(viewport, clipped, png, captured, scale, unseen));
  }
  /** Read a viewport: its image at full resolution up to VIEWPORT_CAP, and with ocr the text in it. Only looks. */
  private async readViewport(address: Extract<ComputerAddress, { kind: "viewport" }>, cwd: string, views: readonly string[] | undefined, signal?: AbortSignal): Promise<ComputerResult> {
    const view = parseComputerViews(views);
    if (view.kind !== "overview" || view.changes || view.regions || view.aria || view.capture.granularity === "ui" || Object.keys(view.capture).some(key => key !== "granularity"))
      throw new ComputerRequestError("A viewport Read shows its image; add ocr for the text in it. Read its window's address for other views.");
    const viewport = this.viewport(address);
    const session = (await this.routeAddress(cwd, address, signal)).session;
    const captured = await session.windowPixels(viewport.window_ref, signal);
    const png = ComputerResources.pixels(captured);
    if (!png) return captured;
    const full = await pngSize(png), clipped = clipViewport(viewport.rect, full);
    if (!clipped) throw new ComputerRequestError(`${viewportSource(viewport.window_ref, viewport.name)} lies outside its window now. Move it with computer_view.`);
    const result = await this.showViewport(viewport, clipped, png, captured, this.imageScale(session, viewport.window_ref, full));
    if (!view.ocr) return result;
    const image = result.content.find(block => block.type === "image")!;
    let lines;
    // The whole image as a region: Windows OCR then reads it enlarged, so small text of a small viewport reads too.
    try { lines = await session.recognizeText(image, { x: 0, y: 0, ...result.details.viewport!.image }, signal); }
    catch (error) { throw new ComputerRequestError(`Text recognition failed: ${error instanceof Error ? error.message : error}`); }
    return { ...result, details: { ...result.details, text_lines: lines } };
  }
  /**
   * Move, resize, minimize, maximize, focus or restore a window by its address: a fresh native state sample bounds the
   * one command, so no window-state address is handed out.
   */
  async manageWindow(address: ComputerAddress, cwd: string, command: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind !== "window") throw new ComputerRequestError("computer_window needs a window address from Search, Read or a name.");
    let management: WindowManagementCommand | undefined;
    if (command.action !== "restore") {
      try { management = parseWindowManagement(command); }
      catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    }
    const place = this.place(address);
    const session = await this.sessionFor(cwd, { window_ref: address.ref }, signal);
    this.retireWindow(address.ref);
    const state = await session.observeWindowState(address.ref, signal);
    const id = state.details.window_state_id;
    if (state.details.status !== "observed" || !id) return this.stamp(place, state);
    if (management && state.details.window_state_kind !== "management")
      return this.stamp(place, { ...state, content: [{ type: "text", text: "This native runtime can only restore and activate windows, not move, resize, minimize, maximize or focus them." }],
        details: { ...state.details, status: "refused" } });
    const started = performance.now();
    const result = management ? await session.manageWindow(address.ref, id, management, signal) : await session.restoreWindow(address.ref, id, signal);
    return this.stamp(place, ComputerResources.watched(result, session.markWatches(address.ref, String(command.action), started, performance.now())));
  }
  /**
   * Run one page operation (navigation, tabs, dialogs, files, page code) in a browser window by its address. The
   * window's earlier observations retire, and the page's next snapshot becomes its current observation.
   */
  async browserAction(address: ComputerAddress, cwd: string, command: Record<string, unknown>, signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind !== "window") throw new ComputerRequestError("computer_browser needs the window address of a browser opened with computer_open or attached to it.");
    if (!PAGE_ACTIONS.includes(String(command.action))) throw new ComputerRequestError(`computer_browser runs ${PAGE_ACTIONS.join(", ")}.`);
    let action;
    try { action = validateWebAction(command); }
    catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    const place = this.place(address);
    const session = await this.sessionFor(cwd, { window_ref: address.ref }, signal);
    this.retireWindow(address.ref);
    const result = await session.actPage(address.ref, action, signal);
    return this.stamp(place, result.details.dom ? this.remember({ window_ref: address.ref }, result) : result);
  }
  /**
   * One typed input on a window by its address. The window picks the backend: Playwright for page refs, locators
   * and CSS points of a browser page, the native driver and UI Automation otherwise. Native points are pixels of the
   * window's latest image; without a current one the window is captured first. The receipt names its machine.
   */
  async input(address: ComputerAddress, cwd: string, plan: InputPlan, signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind !== "window" && address.kind !== "viewport")
      throw new ComputerRequestError("Give the window address from Search, Read or a name, such as computer:zinpc/w3qk or computer:game, or a viewport address such as computer:game/pano.");
    // In a viewport, points are pixels of the viewport's image and its pixels show what the action changed.
    const viewport = address.kind === "viewport" ? this.viewport(address) : undefined;
    if (viewport && plan.space !== undefined) throw new ComputerRequestError("space does not apply in a viewport: its points are pixels of the viewport's image.");
    const place = this.place(address);
    const session = await this.sessionFor(cwd, { window_ref: address.ref }, signal);
    const started = performance.now();
    let result = await this.inputStep(address.ref, session, plan, cwd, signal, viewport);
    // A follow-up such as Enter after typing runs only after the first part was delivered.
    if (plan.then && result.details.status === "delivered") {
      const next = await this.inputStep(address.ref, session, plan.then, cwd, signal, viewport);
      result = { ...next, content: [...result.content, ...next.content] };
    }
    return this.stamp(place, ComputerResources.watched(result, session.markWatches(address.ref, plan.label, started, performance.now())));
  }
  /** An action's receipt with its spans in the running watches of its window. */
  private static watched(result: ComputerResult, spans: NonNullable<ComputerResult["details"]["watch_spans"]>): ComputerResult {
    return spans.length ? { ...result, details: { ...result.details, watch_spans: spans } } : result;
  }
  /**
   * Start a watch for computer_record: frames of a window, or of a viewport at its own pixels, captured in the
   * background while the agent acts. The receipt names the sequence address that grows until watch_stop.
   */
  async watch(address: ComputerAddress, cwd: string, options: { fps?: number; timeout_ms?: number; maxLongEdge?: number }, signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind !== "window" && address.kind !== "viewport")
      throw new ComputerRequestError("watch takes a window address, or a viewport address from computer_view such as computer:game/pano to watch part of a window.");
    const viewport = address.kind === "viewport" ? this.viewport(address) : undefined;
    const place = this.place(address);
    const session = await this.sessionFor(cwd, { window_ref: address.ref }, signal);
    const watching = viewport ? viewportSource(viewport.window_ref, viewport.name) : computerSource("window", address.ref);
    return this.stamp(place, await session.startWatch(address.ref, watching, { fps: options.fps ?? WATCH_DEFAULTS.fps,
      timeout_ms: options.timeout_ms ?? WATCH_DEFAULTS.timeout_ms, maxLongEdge: options.maxLongEdge ?? WATCH_DEFAULTS.maxLongEdge, ...(viewport ? { crop: viewport.rect } : {}) }, signal));
  }
  /** Stop a watch: its contact sheet with actions marked, change statistics and files, in `to` (a workspace folder) when given. */
  async stopWatch(address: ComputerAddress, cwd: string, options: { to?: string; video?: boolean }, signal?: AbortSignal): Promise<ComputerResult> {
    if (address.kind !== "sequence") throw new ComputerRequestError("watch_stop takes the sequence address its watch returned.");
    const place = this.place(address);
    const { session } = await this.routeAddress(cwd, address, signal);
    return this.stamp(place, await session.stopWatch(address.ref, { ...(options.to !== undefined ? { dir: resolve(cwd, options.to) } : {}), animation: options.video === true }));
  }
  private async inputStep(window: string, session: ComputerSession, plan: InputPlan, cwd: string, signal?: AbortSignal, viewport?: Viewport): Promise<ComputerResult> {
    const ref = refKind(plan.target);
    const browser = session.isBrowserWindow(window);
    // A viewport of a browser window is pixels of the window, like space "window".
    if (browser && !viewport && plan.space !== "window" && ref !== "hint") return this.pageInput(window, session, plan, cwd, signal);
    if (plan.space !== undefined && !browser) throw new ComputerRequestError("space applies to browser windows only; points on other windows are pixels of the window's latest image.");
    if (ref === "page") throw new ComputerRequestError(`${plan.target} is a page ref from a DOM Read; ${browser ? "omit space: \"window\" to act on the page" : "this window is not a browser page, so use a ref from its latest Read or a Playwright locator"}.`);
    return this.nativeStep(window, session, plan, cwd, signal, viewport);
  }

  /** Typed input on the active page of a browser window through Playwright; a current DOM observation gives the change list. */
  private async pageInput(window: string, session: ComputerSession, plan: InputPlan, cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    if (typeof plan.web === "string") throw new ComputerRequestError(plan.web);
    // A page timeline carries its own points and targets; other page actions take the element target.
    const target = plan.web.action !== "timeline" && typeof plan.target === "string" ? refKind(plan.target) === "page" ? { ref: plan.target } : plan.target : undefined;
    const command = { ...plan.web, ...(target !== undefined ? { target } : {}) };
    let action: WebAction;
    try { action = validateWebAction(command); }
    catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    const dom = session.inputView(window).dom;
    if (dom && this.snapshots.has(dom)) return this.performAt({ kind: "observation", ref: dom, source: computerSource("observation", dom) }, cwd, JSON.stringify(command), signal);
    this.retireWindow(window);
    const result = await session.actPage(window, action, signal);
    return result.details.dom ? this.remember({ window_ref: window }, result) : result;
  }

  /**
   * Typed input on a native window: a locator resolves in fresh UI walks, a ref of the latest Read and points use the
   * window's current observation, captured first when there is none with the pixels a point needs. A click or scroll
   * on a target goes through UI Automation; when no pattern carries it, which sends nothing, it goes again as real input.
   */
  private async nativeStep(window: string, session: ComputerSession, plan: InputPlan, cwd: string, signal?: AbortSignal, viewport?: Viewport): Promise<ComputerResult> {
    if (typeof plan.native === "string") throw new ComputerRequestError(plan.native);
    const command: Record<string, unknown> = structuredClone(plan.native);
    const action = String(command.action);
    // What the agent sees structurally is pressed structurally: a click or scroll on a target goes through UI Automation
    // alone, and the driver refuses before sending anything when no pattern carries it. Points, keys, drags and timelines
    // are real input; semantic actions and menus are UI Automation calls of their own. No pattern carries a multi-click.
    const structural = !plan.real && plan.target !== undefined && plan.point === undefined && STRUCTURAL.includes(action) && command.unit === undefined && command.modifiers === undefined && command.count === undefined;
    if (structural) command.uia_only = true;
    else if (!isSemanticAction(action) && action !== "menu") command.delivery_mode = "foreground";
    let target = plan.target;
    let view = session.inputView(window);
    // The registry decides whether an observation still grounds input: a detail Read, a sequence or the registry's
    // size limit can spend it while the session still names it as the window's current one.
    if (view.native && !this.snapshots.has(view.native.id)) view = { ...view, native: undefined };
    // Actions that only exist on locators take a ref of the latest Read as the locator that names its element.
    if (refKind(target) === "hint" && (LOCATOR_ONLY.includes(action) || command.option !== undefined)) target = suggestLocator(this.hinted(view, target as string));
    if (command.option !== undefined) {
      if (refKind(target) !== "locator") throw new ComputerRequestError(`${plan.label} with values needs the list as target.`);
      target = `${target}.getByRole("option", { name: ${JSON.stringify(command.option)}, exact: true })`;
      delete command.option;
    }
    let result: ComputerResult;
    // The viewport's part of the window's full-resolution capture, when the action is in a viewport.
    let box: PixelBox | undefined;
    // What the real-input retry sends: the input observation is spent by then, so its refs become locators or points.
    let retry = (): InputPlan => plan;
    if (refKind(target) === "locator") {
      if (plan.end) throw new ComputerRequestError(`${plan.label} takes refs of the window's latest Read or points, not locators.`);
      result = await this.performAt({ kind: "window", ref: window, source: computerSource("window", window) }, cwd, JSON.stringify({ ...command, target }), signal);
    } else {
      const hint = refKind(target) === "hint" ? target as string : undefined;
      // Only a locator waits for its element; refs and points act on the current observation at once.
      delete command.timeout_ms;
      const pixels = plan.point !== undefined || plan.end !== undefined || command.unit === "wheel_detents" || action === "timeline";
      if (hint) this.hinted(view, hint);
      else if (!view.native || pixels && view.native.width === undefined || viewport && !view.native.full) {
        // A quiet capture: the image the agent saw stays the space of its points. A viewport maps its points into a
        // full-resolution capture; other points go to a capture the size of the agent's latest image.
        const seen = view.seen ? Math.max(64, view.seen.width, view.seen.height) : undefined;
        this.retireWindow(window, "native");
        const captured = this.remember({ window_ref: window }, await (viewport ? session.observeFull(window, signal)
          : session.observeQuiet(window, signal, { granularity: "image", ...(seen && seen <= FULL_RESOLUTION ? { maxLongEdge: seen, scale: 1 } : {}) })));
        if (captured.details.status !== "observed") return captured;
        view = session.inputView(window);
      }
      const native = view.native!;
      if (pixels && native.width === undefined) throw new ComputerRequestError(`${plan.label} at a point needs the window's pixels: Read the window with an image, or give a locator.`);
      // Points are in the latest image the agent saw; the current observation can be a capture of another size.
      const sx = native.width && view.seen ? native.width / view.seen.width : 1, sy = native.height && view.seen ? native.height / view.seen.height : 1;
      // In a viewport they are pixels of its image instead, mapped into the full-resolution capture.
      box = viewport && native.full ? clipViewport(viewport.rect, { width: native.width!, height: native.height! }) : undefined;
      if (viewport && !hint && !box) throw new ComputerRequestError(`${viewportSource(viewport.window_ref, viewport.name)} lies outside its window now. Move it with computer_view.`);
      const at = (point: InputPoint) => {
        if (!box) return { x: Math.min(native.width! - 1, Math.round(point.x * sx)), y: Math.min(native.height! - 1, Math.round(point.y * sy)) };
        const inside = windowPoint(box, point), image = viewportImageSize(box);
        if (!inside) throw new ComputerRequestError(`${point.x},${point.y} lies outside ${viewportSource(viewport!.window_ref, viewport!.name)}: its image is ${image.width}x${image.height}.`);
        return inside;
      };
      const seen = (point: InputPoint) => box ? viewportPoint(box, point) : { x: point.x / sx, y: point.y / sy };
      const centre = (ref: string) => {
        const box = this.hinted(view, ref).bounds.window_image;
        if (!box || native.width === undefined) throw new ComputerRequestError(`${ref} has no place in the window's image; give a point or a locator.`);
        return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
      };
      if (action === "drag") {
        const from = hint ? centre(hint) : plan.point ? at(plan.point) : undefined;
        const end = plan.end?.target !== undefined ? refKind(plan.end.target) === "hint" ? centre(plan.end.target as string) : undefined : plan.end?.point ? at(plan.end.point) : undefined;
        if (!from || !end) throw new ComputerRequestError("drag on a native window goes from and to refs of the window's latest Read or points.");
        Object.assign(command, { from_x: from.x, from_y: from.y, to_x: end.x, to_y: end.y });
        if (Array.isArray(command.via)) command.via = (command.via as InputPoint[]).map(at);
        retry = () => ({ ...plan, target: undefined, point: seen(from), end: { point: seen(end) } });
      } else if (action === "timeline") {
        command.events = (command.events as Record<string, unknown>[]).map(event => typeof event.x === "number" && typeof event.y === "number" ? { ...event, ...at(event as unknown as InputPoint) } : event);
      } else if (plan.point) Object.assign(command, at(plan.point));
      else if (command.unit === "wheel_detents") Object.assign(command, box ? { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) } : { x: Math.floor(native.width! / 2), y: Math.floor(native.height! / 2) });
      if (hint && action !== "drag") retry = () => NATIVE_LOCATOR_ACTIONS.includes(LOCATOR_VERBS[action] ?? action) ? { ...plan, target: suggestLocator(this.hinted(view, hint)) }
        : { ...plan, target: undefined, point: seen(centre(hint)) };
      const observation = { kind: "observation" as const, ref: native.id, source: computerSource("observation", native.id), ...(hint && action !== "drag" ? { hint } : {}) };
      result = await this.performAt(observation, cwd, JSON.stringify(command), signal, box);
    }
    if (viewport) result = { ...result, details: { ...result.details, viewport: ComputerResources.viewportDetails(viewport, box ?? viewport.rect) } };
    const capability = result.details.action_capability;
    if (!structural || result.details.status !== "refused" || capability?.background !== "unavailable") return result;
    // A ref acted on a capture without the viewport's pixels; its retry point is in the window's latest image.
    const again = await this.nativeStep(window, session, { ...retry(), real: true }, cwd, signal, box ? viewport : undefined);
    return { ...again, content: [{ type: "text", text: `No UI Automation pattern of the target carried this ${plan.label}, so this call used the real pointer.` }, ...again.content],
      ...(viewport ? { details: { ...again.details, viewport: again.details.viewport ?? result.details.viewport } } : {}) };
  }

  /** The element of a ref in the window's current observation. */
  private hinted(view: ReturnType<ComputerSession["inputView"]>, hint: string): UiElement {
    const element = view.native?.ui?.elements.find(item => item.hint === hint);
    if (!element) throw new ComputerRequestError(`${hint} is not a ref of this window's latest Read, or input since then spent it: Read the window again, or give a Playwright locator.`);
    return element;
  }
  /** Dispatch exactly one JSON command of a computer_* tool against its address-bound target; the receipt names its machine. */
  async perform(address: ComputerAddress, cwd: string, value: string, signal?: AbortSignal): Promise<ComputerResult> {
    const place = this.place(address);
    return this.stamp(place, await this.performAt(address, cwd, value, signal));
  }
  private async performAt(address: ComputerAddress, cwd: string, value: string, signal?: AbortSignal, viewport?: PixelBox): Promise<ComputerResult> {
    if (address.kind === "sandbox") {
      const sandbox = this.sandbox(address.ref);
      const command = commandObject(value);
      if (command.action !== "open") throw new ComputerRequestError("A sandbox address opens apps.");
      const result = await sandbox.session.open(openTarget(command, "in the sandbox"), signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (address.kind === "machine") {
      if (address.part) throw new ComputerRequestError(`Give ${computerSource("machine", address.ref)} itself, not its windows, apps or displays.`);
      const command = commandObject(value);
      const remote = address.ref === LOCAL_MACHINE ? undefined : address.ref;
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
        throw new ComputerRequestError(`A machine address accepts open, open_browser, open_sandbox, open_session, webview2_debugging or ${FILE_ACTIONS.join(", ")}.`);
      const result = await session.open(openTarget(command, "on that machine"), signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (address.kind === "app") {
      only(commandObject(value), ["action"]);
      const app = this.apps.get(address.ref);
      if (!app) throw new ComputerRequestError("App reference expired. Search computer:machine/<name>/apps again.");
      const result = await (await this.machineSession(cwd, app.machine, signal)).open(app.id, signal);
      return result.details.window_ref ? this.remember({ window_ref: result.details.window_ref }, result) : result;
    }
    if (address.kind === "display") {
      const command = commandObject(value);
      if (command.action !== "resize") throw new ComputerRequestError("A display address accepts only resize. Read it for pixels.");
      only(command, ["action", "width", "height"]);
      let mode;
      try { mode = displayMode(command); }
      catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
      const session = await this.sessionFor(cwd, { display: address.ref, machine: address.machine }, signal);
      // Window and display coordinates from before the change no longer hold. Collect them now:
      // a successful change also retires the window references used to recognize them.
      const stale = [...this.snapshots].filter(([, entry]) => entry.target.window_ref !== undefined ? session.hasWindow(entry.target.window_ref) : entry.target.machine === address.machine).map(([id]) => id);
      const result = await session.resizeDisplay(address.ref, mode, signal);
      if (result.details.status !== "refused") { for (const id of stale) this.snapshots.delete(id); this.forget(session, address.machine); }
      return result;
    }
    if (address.kind === "window") {
      const command = commandObject(value);
      const session = await this.sessionFor(cwd, { window_ref: address.ref });
      if (command.action === "attach_browser") {
        only(command, ["action"]);
        return session.attachBrowser(address.ref, signal);
      }
      if (command.target !== undefined && command.action !== "wait_for" && command.action !== "verify") {
        if (session.isBrowserWindow(address.ref)) throw new ComputerRequestError("A browser window's locators resolve in its page through Playwright.");
        return this.locatorAction(address.ref, session, command, cwd, signal, { successor: true, explicit: false });
      }
      if (command.action !== "wait_for" && command.action !== "verify")
        throw new ComputerRequestError("A window address accepts an action with a target (a Playwright locator such as getByRole(\"button\", { name: \"Save\" })), wait_for, verify or attach_browser.");
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
    if (window && commandObject(value).target !== undefined && !snapshot.result.details.dom) {
      if (address.hint !== undefined) throw new ComputerRequestError("Choose the ref or a locator target, not both.");
      this.snapshots.delete(address.ref);
      return this.locatorAction(window, await this.sessionFor(cwd, { window_ref: window }), commandObject(value), cwd, signal, { successor: true, explicit: false });
    }
    const focus = inputFocus(commandObject(value), snapshot.result.details.ui, address.hint);
    let follow = window ? await this.withFrame({ successor: true, explicit: false, ...(focus ? { focus } : {}), ...(viewport ? { viewport } : {}) }, window, address.ref, cwd) : undefined;
    // A page action compares Playwright screenshots of the page, taken before and after it.
    if (follow && window && snapshot.result.details.dom) {
      const page = await this.pageShot(follow.session!, window, address.ref, signal);
      if (page) follow = { ...follow, page };
    }
    const result = await this.act(address, snapshot, value, cwd, signal);
    if (!follow || !window) return result;
    return this.followUp(window, snapshot, result, follow, cwd, signal);
  }

  /** Dispatch one action against its observation: Playwright for DOM observations, CUA otherwise. */
  private async act(address: Extract<ComputerAddress, { kind: "observation" }>, snapshot: Snapshot, value: string, cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    if (snapshot.result.details.dom) {
      if (address.hint !== undefined || !snapshot.target.window_ref)
        throw new ComputerRequestError("A page action takes its target in the command, not a native ref.");
      let command;
      try { command = validateWebAction(commandObject(value)); }
      catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
      this.snapshots.delete(address.ref);
      const result = await (await this.sessionFor(cwd, snapshot.target)).actDom(snapshot.target.window_ref, address.ref, command, signal);
      return result.details.dom ? this.remember({ window_ref: snapshot.target.window_ref }, result) : result;
    }
    if (!snapshot.target.window_ref) throw new ComputerRequestError("Display observations are readonly; choose a window overview for input.");
    const command = commandObject(value);
    if ("window_ref" in command || "observation_id" in command) throw new ComputerRequestError("The window and observation come from the address; omit identity fields.");
    if (address.hint !== undefined) {
      if ("hint" in command || "element_token" in command || "x" in command || "y" in command)
        throw new ComputerRequestError("Choose the address hint or a JSON target, not both.");
      command.hint = address.hint;
    }
    const action = { ...command, window_ref: snapshot.target.window_ref, observation_id: address.ref } as Action;
    const session = await this.sessionFor(cwd, snapshot.target);
    let result = await session.act(action, signal);
    // Delivered pixel-only input keeps the observation usable until a successor replaces it; anything else, including a refusal, spends it.
    if (result.details.status !== "delivered" || !session.holdsObservation(snapshot.target.window_ref!, address.ref)) this.snapshots.delete(address.ref);
    // Windows refused to activate the target: say who holds the foreground, so a blocked desktop is not mistaken for a bad target.
    if (/foreground_unavailable/.test(JSON.stringify(result.details.state ?? {})) && session.host) {
      const owner = await session.host.foregroundOwner().catch(() => undefined);
      if (owner) result = { ...result, content: [...result.content, { type: "text", text:
        `Windows kept the foreground on ${owner.name} (pid ${owner.pid}). If that is not a window this task opened (for example a system service after a UAC prompt), Windows also blocks injected input there until a person clicks or presses a key on that machine: ask the user to do that, then Read again.` }] };
    }
    return result;
  }

  /** A Playwright screenshot of a browser window's page in CSS pixels, or undefined when it cannot be taken. */
  private async pageShot(session: ComputerSession, window: string, observation: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    const shot = await session.webImage(window, observation, "page", undefined, signal, true).catch(() => undefined);
    const image = shot?.details.status === "observed" ? shot.content.find(block => block.type === "image") : undefined;
    return image?.type === "image" ? Buffer.from(image.data, "base64") : undefined;
  }

  /** Keep the input observation's own pixels as the baseline of the pixel comparison; they must be taken before the action. */
  private async withFrame(follow: FollowUp, window: string, observation: string | undefined, cwd: string): Promise<FollowUp> {
    if (!follow.successor) return follow;
    const session = await this.sessionFor(cwd, { window_ref: window });
    const frame = session.windowFrame(window);
    return { ...follow, session, ...(frame && frame.observation_id === observation ? { frame } : {}) };
  }

  /** After an action, attach the successor observation with a compact diff from the action's input observation. */
  private async followUp(window: string, before: Snapshot, result: ComputerResult, follow: FollowUp, cwd: string, signal?: AbortSignal): Promise<ComputerResult> {
    const status = result.details.status;
    if (!follow.successor) return result;
    // A default successor stays quiet when there is nothing to compare: a refusal sent nothing, and a browser
    // action that returned no page snapshot would otherwise be compared with a native walk of the browser window.
    if (!follow.explicit && (status === "refused" || (before.result.details.dom && !result.details.dom))) return result;
    // A cancelled call returns its receipt without capturing again.
    if (signal?.aborted) return result;
    const session = follow.session ?? await this.sessionFor(cwd, { window_ref: window });
    let successor: ComputerResult | undefined, settled: StateDiff | undefined, crops: ComputerResult["content"] = [];
    if (status !== "refused") {
      if (result.details.dom) successor = result;
      else ({ successor, diff: settled, crops } = await this.settle(window, session, before, follow.frame, signal, follow.focus, follow.viewport));
    }
    const after = successor?.details;
    const diff = before.result.details.dom && after?.dom ? diffDom(before.result.details.dom, after.dom)
      : settled ?? (before.result.details.ui && after?.ui ? diffUi(before.result.details.ui, after.ui) : undefined);
    if (diff && follow.page && after?.dom && after.observation_id) {
      const shot = await this.pageShot(session, window, after.observation_id, signal);
      if (shot) {
        const [a, b] = await Promise.all([decodeFrame(follow.page), decodeFrame(shot)]);
        diff.pixels = { ...diffFrames(a, b, follow.focus ? { focus: follow.focus } : {}), space: "page" };
        crops = await cropImages(follow.page, shot, diff);
      }
    }
    // The successor replaces the action's own observation as the current one; a wait retired the earlier snapshot.
    const details = { ...result.details, ...(after?.observation_id ? { observation_id: after.observation_id, ...(after.dom ? { dom: after.dom } : {}) } : {}),
      successor: after?.observation_id ? { observation_id: after.observation_id, ...(diff ? { diff } : { reason: "The input observation had no comparable UI or DOM." }) }
        : { reason: status === "refused" ? "The action was refused; the input observation is unchanged but consumed." : "No successor observation could be taken." } };
    return { ...result, content: [...result.content, ...crops], details };
  }

  /**
   * Capture the window after native input until its state is known: when nothing changed yet, look again for up to
   * SETTLE_MS before saying so; once something changed, capture until two captures in a row are identical, for up
   * to STEADY_MS, so the change list shows the settled window rather than a frame in the middle of a repaint.
   * Captures keep the input observation's overview size so their pixels compare with it.
   */
  private async settle(window: string, session: ComputerSession, before: Snapshot, frame: WindowFrame | undefined, signal?: AbortSignal, focus?: InputPoint, viewport?: PixelBox):
    Promise<{ successor: ComputerResult; diff?: StateDiff; crops: ComputerResult["content"] }> {
    const started = performance.now();
    // Full-resolution captures continue at full resolution without changing the size of the image the agent saw.
    const full = !!frame && frame.size.maxLongEdge >= FULL_RESOLUTION;
    // A viewport compares only its own pixels, cut from full-resolution captures of the window.
    const scope = full ? viewport : undefined;
    const cut = async (png: Buffer) => scope ? viewportImage(png, scope).catch(() => undefined) : png;
    let options: UiCaptureOptions = { granularity: "full", ...(frame ? frame.size : {}) };
    const first = frame ? await cut(frame.png) : undefined;
    const baseline: Capture = { ui: before.result.details.ui, frame: first ? await decodeFrame(first) : undefined };
    const context = scope ? focus ? { focus: viewportPoint(scope, focus) } : {} : diffContext(before.result.details.ui, baseline.frame, focus);
    let successor: ComputerResult, diff: StateDiff | undefined, previous: Capture | undefined, latest: Buffer | undefined;
    for (let attempt = 0; ; attempt++) {
      this.retireWindow(window);
      successor = this.remember({ window_ref: window }, await (full && options.granularity !== "ui" ? session.observeFull(window, signal) : session.observeQuiet(window, signal, options)));
      const waited = Math.round(performance.now() - started);
      // A window whose pixels cannot be captured (minimized, or a failed screenshot) still gets its UI compared.
      if (successor.details.status !== "observed" && options.granularity === "full" && !signal?.aborted) {
        options = { granularity: "ui" }; baseline.frame = undefined; attempt--; continue;
      }
      if (successor.details.status !== "observed" || signal?.aborted) break;
      const captured = session.windowFrame(window);
      latest = captured && captured.observation_id === successor.details.observation_id ? await cut(captured.png) : undefined;
      const current: Capture = { ui: successor.details.ui, frame: latest ? await decodeFrame(latest) : undefined };
      diff = compareCaptures(baseline, current, context);
      if (!diff) break;
      diff.waited_ms = waited;
      if (diffIsEmpty(diff)) {
        if (waited >= SETTLE_MS) break;
        previous = undefined;
        await new Promise(resolve => setTimeout(resolve, Math.min([30, 60, 100][attempt] ?? 150, SETTLE_MS - waited)));
        continue;
      }
      const steady = previous && compareCaptures(previous, current);
      if (steady && diffIsEmpty(steady)) break;
      if (waited >= STEADY_MS) { diff.unsettled = true; break; }
      previous = current;
    }
    if (scope && diff?.pixels) diff.pixels.space = "viewport";
    return { successor, diff, crops: diff && first && latest ? await cropImages(first, latest, diff) : [] };
  }

  /**
   * Resolve a Playwright locator the way Playwright's actions do: take fresh UI walks until exactly one element
   * matches and is ready (enabled for input; for pointer input also on screen and at the same place in two walks), or
   * until the timeout. Several matches refuse at once with each match's locator, like Playwright's strict mode.
   */
  private async resolveNative(window: string, session: ComputerSession, selector: ParsedSelector, options: { timeout_ms: number; enabled: boolean; stable: boolean; visible?: boolean; describe: string; pixels?: boolean }, signal?: AbortSignal):
    Promise<{ element: UiElement; observation: ComputerResult } | { refused: string; observation?: ComputerResult }> {
    const deadline = performance.now() + options.timeout_ms;
    let previous: UiElement | undefined, reason = "";
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) return { refused: "Cancelled while waiting for the target; nothing was sent." };
      this.retireWindow(window);
      const fresh = this.remember({ window_ref: window }, await session.observeQuiet(window, signal, options.pixels ? { granularity: "full" } : undefined));
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
      else if (options.visible && !isVisible(element)) reason = "the element is not visible (offscreen); invoke, select and other semantic actions do not need it on screen";
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
  private async locatorAction(window: string, session: ComputerSession, command: Record<string, unknown>, cwd: string, signal?: AbortSignal, follow?: FollowUp): Promise<ComputerResult> {
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
    // With a successor, the resolving walks also capture pixels: the last one is the pixel baseline of the action.
    const resolved = await this.resolveNative(window, session, selector, { timeout_ms: (timeout as number | undefined) ?? 5_000, enabled: action !== "hover", stable: pointer, visible: pointer, describe, pixels: follow?.successor }, signal);
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
    // The walk that resolved the target is the state before the action: the change list compares with it.
    const before: Snapshot = { target: { window_ref: window }, result: observation };
    const box = element.bounds.window_image;
    if (follow) follow = await this.withFrame({ ...follow, ...(box ? { focus: { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } } : {}) },
      window, observation.details.observation_id, cwd);
    const finish = (result: ComputerResult) => follow ? this.followUp(window, before, result, follow, cwd, signal) : Promise.resolve(result);
    this.snapshots.delete(observation.details.observation_id!);
    const result = await session.act(nativeCommand as Action, signal);
    const prefix = { type: "text" as const, text: `Target ${describe} resolved to ${named}.` };
    if ((action !== "check" && action !== "uncheck") || result.details.status !== "delivered") return finish({ ...result, content: [prefix, ...result.content] });
    // Like Playwright's check(): confirm the new state, and say so when the app did not change it.
    const after = await this.resolveNative(window, session, selector, { timeout_ms: 2_000, enabled: false, stable: false, describe }, signal);
    const state = "element" in after ? checkedState(after.element) : null;
    return finish(state === (action === "check") ? { ...result, content: [prefix, ...result.content, { type: "text", text: `It is now ${action}ed.` }] }
      : done("unknown", `${prefix.text} The click was delivered, but the element is ${state === null ? "no longer readable" : state === "mixed" ? "mixed" : state ? "checked" : "unchecked"} afterwards. Read the window before deciding; do not replay blindly.`));
  }

}

/** Parse a tool-owned path without allowing an unknown computer URI to fall through to files. */
export function requireComputerAddress(source: string): ComputerAddress {
  let address;
  // A malformed address is a refused request: nothing was sent anywhere.
  try { address = parseComputerAddress(source); }
  catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
  if (!address) throw new ComputerRequestError("Not a computer resource.");
  return address;
}

/** The actual native result text, useful for refusal and uncertainty receipts. */
export function computerResultText(result: ComputerResult): string { return text(result); }
