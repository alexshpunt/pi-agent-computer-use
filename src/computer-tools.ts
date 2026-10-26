import { Type, type JsonValue, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ComputerRequestError, refKind, type ComputerResources, type InputPlan, type InputPoint } from "./computer-resources.ts";
import type { ComputerAddress } from "./computer-address.ts";
import { computerActionRenderer } from "./computer-action-renderer.ts";
import { parseComputerViews } from "./computer-views.ts";
import { COMPUTER_DELETE_HELP, computerAction, deleteComputer } from "./provider.ts";

const plain = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
type Action = Awaited<ReturnType<typeof computerAction>>;

/**
 * The namespace every computer_* tool shares. tool_search indexes its instructions into every tool's search text,
 * so they point to the guide instead of holding it: the guide names every operation and would make all tools match
 * every query equally.
 */
export function computerNamespace() {
  return { name: "computer", description: "Read and operate Windows app windows, displays and browser pages through computer: addresses",
    instructions: "Read docs:computer for the guide: with Read in Pi Agent IDE, with computer_read without it." };
}
/** Codemode scripts receive the receipt object for every outcome, so they branch on outcome without try/catch. */
export const receiptSchema = Type.Object({ outcome: Type.String(), effect: Type.String() }, { additionalProperties: true });

/** A tool result of one computer action: its summary and images for the model, its receipt for scripts. */
export function actionResult(action: Action) {
  // The receipt is plain data with a few untyped native fields; a JSON copy gives scripts exactly that.
  const receipt: JsonValue = JSON.parse(JSON.stringify(action.script));
  return { content: [{ type: "text" as const, text: action.summary }, ...("images" in action ? action.images ?? [] : [])],
    details: { results: [], metadata: { semanticAction: action.data } }, structuredContent: receipt, ...(action.data.ok ? {} : { isError: true }) };
}

const openParameters = Type.Object({
  at: Type.String({ description: "Where to open: computer:machine/<name> (local is this machine), a computer:sandbox/... address, an app address from Search computer:machine/<name>/apps, or the window address of a running Chromium-based browser or app to attach Playwright to." }),
  app: Type.Optional(Type.String({ description: "Installed app name as Search computer:machine/<name>/apps lists it, such as Notepad." })),
  path: Type.Optional(Type.String({ description: "YOLO: absolute Windows path of an .exe to start, such as C:\\Tools\\app.exe." })),
  args: Type.Optional(Type.Array(Type.String(), { maxItems: 32, description: "Command-line arguments for path." })),
  debugging: Type.Optional(Type.Boolean({ description: "Start the WebView2 app at path with its debugging port open, so its window can be attached." })),
  browser: Type.Optional(Type.Union([Type.Literal("chrome"), Type.Literal("msedge"), Type.Literal("firefox")], { description: "Open a new visible browser driven by Playwright; its window takes DOM reads and page actions." })),
  url: Type.Optional(Type.String({ description: "http(s) page the new browser opens." })),
  profile: Type.Optional(Type.Literal("agent", { description: "YOLO: use the agent's own persistent browser profile, which keeps its logins between sessions. Omit for a disposable profile." })),
  sandbox: Type.Optional(Type.Object({
    import: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Object({ host: Type.String(), guest: Type.Optional(Type.String()), writable: Type.Optional(Type.Boolean()) }, { additionalProperties: false })]),
      { maxItems: 8, description: "Host folders shared into the sandbox, read-only unless writable." })),
    export: Type.Optional(Type.String({ description: "One host folder the sandbox can write to." })),
  }, { additionalProperties: false, description: "Open a disposable Windows Sandbox on that machine, apart from the user's desktop; pass {} for no shared folders." })),
  isolated_session: Type.Optional(Type.Boolean({ description: "Open an isolated agent session on that machine, with its own desktop and foreground input." })),
  webview2_debugging: Type.Optional(Type.Object({
    app: Type.String({ description: "The app's executable file name, such as ms-teams.exe." }),
    enabled: Type.Boolean({ description: "true opens the debugging port from the app's next start, whoever starts it; false turns it off again." }),
  }, { additionalProperties: false, description: "YOLO: set a WebView2 app's debugging port for its next start on that machine, so its window can be attached; opens nothing. Windows may ask the person there to approve the change." })),
}, { additionalProperties: false });

/** The command that opens what computer_open asks for at this address. */
export function openCommand(address: ComputerAddress, params: Static<typeof openParameters>): Record<string, unknown> {
  const { app, path, args, debugging, browser, url, profile, sandbox, isolated_session, webview2_debugging } = params;
  const chosen = [app !== undefined && "app", path !== undefined && "path", (browser ?? url ?? profile) !== undefined && "browser",
    sandbox !== undefined && "sandbox", isolated_session === true && "isolated_session", webview2_debugging !== undefined && "webview2_debugging"].filter(Boolean);
  if (chosen.length > 1) throw new ComputerRequestError(`Open one thing at a time: ${chosen.join(" and ")} were both given.`);
  if ((args !== undefined || debugging !== undefined) && path === undefined) throw new ComputerRequestError("args and debugging go with path.");
  const what = chosen[0];
  if (address.kind === "app" || address.kind === "window") {
    if (what) throw new ComputerRequestError(`${address.kind === "app" ? "An app address opens that app" : "A window address attaches Playwright to that browser"}; give a machine address to open ${what}.`);
    return { action: address.kind === "app" ? "open" : "attach_browser" };
  }
  if (address.kind !== "machine" && address.kind !== "sandbox" || address.kind === "machine" && address.part)
    throw new ComputerRequestError("Open at computer:machine/<name>, a sandbox address, an app address or a browser window address.");
  if (what === "app") return { action: "open", app };
  if (what === "path") return { action: "open", path, ...(args ? { args } : {}), ...(debugging !== undefined ? { debugging } : {}) };
  if (address.kind === "sandbox" && what) throw new ComputerRequestError("A sandbox opens apps by app or path.");
  if (what === "browser") return { action: "open_browser", ...(browser ? { browser } : {}), ...(url ? { url } : {}), ...(profile ? { profile } : {}) };
  if (what === "sandbox") return { action: "open_sandbox", ...sandbox };
  if (what === "isolated_session") return { action: "open_session" };
  if (what === "webview2_debugging") return { action: "webview2_debugging", ...webview2_debugging };
  throw new ComputerRequestError("Name what to open: app, path, browser or url, sandbox, isolated_session or webview2_debugging.");
}

const windowParameters = Type.Object({
  window: Type.String({ description: "Window address from Search, Read or a name, such as computer:zinpc/w3qk or computer:game." }),
  action: Type.Union([Type.Literal("move"), Type.Literal("resize"), Type.Literal("maximize"), Type.Literal("minimize"), Type.Literal("focus"), Type.Literal("restore"), Type.Literal("name")],
    { description: "focus activates a visible window; restore brings a minimized window back and activates it; name gives the window a short address computer:<as>." }),
  as: Type.Optional(Type.String({ description: "name: 1-32 lowercase letters, digits, - or _, starting with a letter, such as game. It resolves until the window closes." })),
  x: Type.Optional(Type.Integer({ description: "move: new left edge in Windows desktop pixels." })),
  y: Type.Optional(Type.Integer({ description: "move: new top edge in Windows desktop pixels." })),
  width: Type.Optional(Type.Integer({ minimum: 1, description: "resize: new width in Windows desktop pixels." })),
  height: Type.Optional(Type.Integer({ minimum: 1, description: "resize: new height in Windows desktop pixels." })),
}, { additionalProperties: false });

/** The window management command of computer_window. */
export function windowCommand(params: Static<typeof windowParameters>): Record<string, unknown> {
  const { window: _window, action, ...fields } = params;
  const wanted = action === "move" ? ["x", "y"] : action === "resize" ? ["width", "height"] : action === "name" ? ["as"] : [];
  const given = Object.keys(fields);
  if (given.some(key => !wanted.includes(key)) || wanted.some(key => !given.includes(key)))
    throw new ComputerRequestError(wanted.length ? `${action} needs ${wanted.join(" and ")} and nothing else.` : `${action} takes no coordinates, size or name.`);
  if (action === "name") return { action, ...fields };
  return { action, ...fields, ...(wanted.length ? { unit: "windows_desktop_pixels" } : {}) };
}

const displayParameters = Type.Object({
  display: Type.String({ description: "computer:machine/<name>/display/primary, or a display address listed by Read computer:machine/<name>/displays." }),
  width: Type.Integer({ minimum: 640, maximum: 16384, description: "New width in physical pixels." }),
  height: Type.Integer({ minimum: 480, maximum: 16384, description: "New height in physical pixels." }),
}, { additionalProperties: false });

/** An element of a window or page: a Playwright locator string, or locator fields that must all match. */
const targetSchema = (description: string) => Type.Union([
  Type.String({ description: "A Playwright locator such as getByRole('button', { name: 'Save' }) or getByLabel('Name').nth(1)." }),
  Type.Object({
    ref: Type.Optional(Type.String({ description: "Browser pages: an aria ref such as e12 from the page's latest snapshot, alone." })),
    role: Type.Optional(Type.String()), name: Type.Optional(Type.String({ description: "Accessible name; needs role." })),
    label: Type.Optional(Type.String()), text: Type.Optional(Type.String()), placeholder: Type.Optional(Type.String()), test_id: Type.Optional(Type.String()),
    css: Type.Optional(Type.String({ description: "Browser pages only." })),
    exact: Type.Optional(Type.Boolean({ description: "Match name and text exactly instead of as a case-insensitive substring." })),
    frames: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: "Browser pages only: CSS selectors of the nested iframes, outermost first." })),
  }, { additionalProperties: false }),
], { description });

const waitParameters = Type.Object({
  window: Type.String({ description: "Window address from Search, Read or a name; a browser window checks its active tab." }),
  conditions: Type.Array(Type.Object({
    target: Type.Optional(targetSchema("The element the check applies to; omit for aria on the whole window or page, and for url_contains and title.")),
    is: Type.Optional(Type.Union([Type.Literal("exists"), Type.Literal("absent"), Type.Literal("visible"), Type.Literal("hidden"), Type.Literal("enabled"), Type.Literal("disabled"), Type.Literal("selected"), Type.Literal("checked"), Type.Literal("unchecked"), Type.Literal("focused")], { description: "State the target is in." })),
    value: Type.Optional(Type.String({ description: "The target's value (its name if it has none, or a page element's text) equals this." })),
    contains: Type.Optional(Type.String({ description: "The target's value, name or text contains this." })),
    count: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, description: "Exactly this many elements match the target." })),
    aria: Type.Optional(Type.String({ description: "Playwright aria snapshot template the target's subtree, or the whole window or page, contains, such as - button /Count \\d+/." })),
    url_contains: Type.Optional(Type.String({ description: "Browser windows: the active tab's URL contains this." })),
    title: Type.Optional(Type.String({ description: "Browser windows: the active tab's title equals this." })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16, description: "Every condition must hold. Each takes one check: is, value, contains, count or aria with a target, aria alone, or url_contains or title alone." }),
  mode: Type.Optional(Type.Union([Type.Literal("wait"), Type.Literal("check")], { description: "wait (default) samples until every condition holds or timeout_ms passes; check takes one sample." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000, description: "wait: longest wait, default 5000." })),
  interval_ms: Type.Optional(Type.Integer({ minimum: 50, maximum: 5000, description: "wait: time between samples, default 250." })),
  stable: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "wait: consecutive satisfied samples required, default 1." })),
}, { additionalProperties: false });

/** The wait_for or verify command of computer_wait. */
export function waitCommand(params: Static<typeof waitParameters>): Record<string, unknown> {
  const { window: _window, mode, conditions, ...timing } = params;
  if (mode === "check" && Object.keys(timing).length) throw new ComputerRequestError(`check takes one sample, so ${Object.keys(timing).join(", ")} do not apply.`);
  return { action: mode === "check" ? "verify" : "wait_for", conditions, ...timing };
}

const browserParameters = Type.Object({
  window: Type.String({ description: "Window address of a browser opened with computer_open or attached to it." }),
  action: Type.Union([Type.Literal("navigate"), Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload"), Type.Literal("wait_load"), Type.Literal("new_tab"), Type.Literal("switch_tab"), Type.Literal("close_tab"), Type.Literal("dialog"), Type.Literal("upload"), Type.Literal("wait_download"), Type.Literal("cancel_download"), Type.Literal("evaluate")], { description: "What to do in the active tab: navigate to url; back, forward or reload; wait_load until the page reaches state; new_tab (optional url) becomes active; switch_tab or close_tab by tab; dialog answers the open JavaScript dialog; upload files into target; wait_download or cancel_download by download; evaluate runs expression." }),
  url: Type.Optional(Type.String({ description: "navigate and new_tab: an http(s) URL." })),
  tab: Type.Optional(Type.String({ description: "switch_tab and close_tab: a tab id such as t2 from the snapshot's tab list; close_tab defaults to the active tab." })),
  state: Type.Optional(Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")], { description: "wait_load: load state to reach, default load." })),
  accept: Type.Optional(Type.Boolean({ description: "dialog: accept (true) or dismiss (false)." })),
  text: Type.Optional(Type.String({ description: "dialog: the answer to an accepted prompt." })),
  target: Type.Optional(targetSchema("upload: the file input, or with chooser the element that opens the file chooser; evaluate: the element passed to a function expression.")),
  files: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 32, description: "upload: absolute WSL or Windows paths of existing files." })),
  chooser: Type.Optional(Type.Boolean({ description: "upload: click target and fill the file chooser it opens; no native dialog appears." })),
  download: Type.Optional(Type.String({ description: "wait_download and cancel_download: a download id such as d1; defaults to the latest." })),
  expression: Type.Optional(Type.String({ description: "evaluate: JavaScript; a function expression is called with the target element. Promises are awaited." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000, description: "Time limit; default 5000 for switch_tab, close_tab, dialog and cancel_download, 30000 otherwise." })),
}, { additionalProperties: false });

const machineSchema = Type.String({ description: "computer:machine/<name>; computer:machine/local is this machine." });

/** A machine address itself, the one place files, clipboard, video and audio commands run. */
function machineAddress(resources: ComputerResources, source: string): ComputerAddress {
  const address = resources.address(source);
  if (address.kind !== "machine" || address.part) throw new ComputerRequestError("Give a machine address such as computer:machine/local or computer:machine/<name>.");
  return address;
}

/** Fields an action takes; any other given field, or a missing required one, refuses the request. */
function fieldsFor(action: string, fields: Record<string, unknown>, allowed: string[], required: string[] = []) {
  const extra = Object.keys(fields).filter(key => fields[key] !== undefined && !allowed.includes(key));
  if (extra.length) throw new ComputerRequestError(`${action} takes no ${extra.join(", ")}.`);
  const missing = required.filter(key => fields[key] === undefined);
  if (missing.length) throw new ComputerRequestError(`${action} needs ${missing.join(" and ")}.`);
}

const filesParameters = Type.Object({
  machine: machineSchema,
  action: Type.Union([Type.Literal("put"), Type.Literal("get"), Type.Literal("list")], { description: "put copies a workspace file into this session's folder on the machine; get copies a file from that folder into the workspace; list shows the folder's Windows path and files. Apps there open and save files in that folder; closing the session removes it." }),
  from: Type.Optional(Type.String({ description: "put: workspace file path." })),
  name: Type.Optional(Type.String({ description: "put: file name in the folder, default the name of from; get: the file to copy out." })),
  to: Type.Optional(Type.String({ description: "get: workspace path to write." })),
}, { additionalProperties: false });

/** The machine command of computer_files. */
export function filesCommand(params: Static<typeof filesParameters>): Record<string, unknown> {
  const { machine: _machine, action, ...fields } = params;
  if (action === "put") fieldsFor(action, fields, ["from", "name"], ["from"]);
  else if (action === "get") fieldsFor(action, fields, ["name", "to"], ["name", "to"]);
  else fieldsFor(action, fields, []);
  return { action: action === "list" ? "files" : action, ...fields };
}

const clipboardParameters = Type.Object({
  machine: machineSchema,
  action: Type.Union([Type.Literal("read"), Type.Literal("write")], { description: "YOLO only; the clipboard is shared with the user's own apps. read returns its formats and text; write replaces it with text or an image." }),
  include_image: Type.Optional(Type.Boolean({ description: "read: also return the clipboard's image as PNG." })),
  text: Type.Optional(Type.String({ description: "write: the text to put on the clipboard." })),
  image: Type.Optional(Type.String({ description: "write: workspace path of an image file to put on the clipboard instead of text." })),
}, { additionalProperties: false });

/** The machine command of computer_clipboard. */
export function clipboardCommand(params: Static<typeof clipboardParameters>): Record<string, unknown> {
  const { machine: _machine, action, ...fields } = params;
  if (action === "read") {
    fieldsFor(action, fields, ["include_image"]);
    return { action: "clipboard_read", ...(fields.include_image ? { image: true } : {}) };
  }
  fieldsFor(action, fields, ["text", "image"]);
  if ((fields.text === undefined) === (fields.image === undefined)) throw new ComputerRequestError("write needs exactly one of text or image.");
  return { action: "clipboard_write", ...(fields.text !== undefined ? { text: fields.text } : { image: fields.image }) };
}

const recordParameters = Type.Object({
  at: Type.String({ description: "video_start, video_stop and audio: computer:machine/<name>; sequence: a window or display address." }),
  action: Type.Union([Type.Literal("video_start"), Type.Literal("video_stop"), Type.Literal("audio"), Type.Literal("sequence")], { description: "video_start records the machine's main display to video (YOLO) until video_stop or seconds pass; video_stop ends it and can fetch the file; audio records the machine's playback for seconds (YOLO); sequence captures frames of a window or display over duration_ms and returns a sequence address, whose frames Read shows with a frames: view." }),
  seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600, description: "video_start: recording limit, 1..600; audio: recording length, 1..300." })),
  to: Type.Optional(Type.String({ description: "video_stop and audio: workspace path to fetch the recorded file into." })),
  transcribe: Type.Optional(Type.Boolean({ description: "audio: add a speech transcript made by faster-whisper on this machine; it can be wrong." })),
  duration_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000, description: "sequence: capture length." })),
  fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "sequence: frames per second to aim for, default 4; the result reports the rate reached." })),
  max_frames: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "sequence: frame limit, default 40." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 90000, description: "sequence: total time limit, at least duration_ms, default 15000." })),
  maxLongEdge: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096, description: "sequence: longest frame edge in pixels." })),
  scale: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1, description: "sequence: frame scale instead of maxLongEdge." })),
  region: Type.Optional(Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false, description: "sequence: part of the window or display to capture, in its local pixels." })),
}, { additionalProperties: false });

const SEQUENCE_FIELDS = ["duration_ms", "fps", "max_frames", "timeout_ms", "maxLongEdge", "scale", "region"];

/**
 * What computer_record runs: a machine command for video and audio, or the Read sequence view of a window or display.
 */
export function recordCommand(params: Static<typeof recordParameters>): { command: Record<string, unknown> } | { views: string[] } {
  const { at: _at, action, ...fields } = params;
  if (action === "sequence") {
    fieldsFor(action, fields, SEQUENCE_FIELDS, ["duration_ms"]);
    const views = [`sequence:${JSON.stringify(fields)}`];
    try { parseComputerViews(views); }
    catch (error) { throw new ComputerRequestError(error instanceof Error ? error.message : String(error)); }
    return { views };
  }
  if (action === "video_start") {
    fieldsFor(action, fields, ["seconds"], ["seconds"]);
    return { command: { action: "record_start", seconds: fields.seconds } };
  }
  if (action === "video_stop") {
    fieldsFor(action, fields, ["to"]);
    return { command: { action: "record_stop", ...fields } };
  }
  fieldsFor(action, fields, ["seconds", "to", "transcribe"], ["seconds"]);
  if (fields.seconds! > 300) throw new ComputerRequestError("audio records at most 300 seconds.");
  return { command: { action: "audio_record", ...fields } };
}

const inputWindow = Type.String({ description: "Window address from Search, Read or a name, such as computer:zinpc/w3qk or computer:game." });
const inputTarget = (what: string) => Type.Optional(Type.String({ description: `${what}: a ref from the window's latest Read (1:a in a window Read, e12 in a page snapshot) or a Playwright locator such as getByRole('button', { name: 'Save' }). On native windows a target is pressed through UI Automation in the background when it supports that, otherwise with the real pointer.` }));
const coordinate = (axis: string) => Type.Optional(Type.Number({ minimum: 0, description: `${axis} of a point instead of target: pixels of the window's latest image, or CSS pixels of a browser page. A point on a native window gets the real pointer: the window comes to the front.` }));
const pointSpace = Type.Optional(Type.Union([Type.Literal("page"), Type.Literal("window")], { description: "Browser windows: page (default) takes refs, locators and CSS points of the page; window takes refs and points of a window Read, such as the browser's own toolbar." }));
const modifiersField = Type.Optional(Type.Array(Type.Union([Type.Literal("ctrl"), Type.Literal("shift"), Type.Literal("alt"), Type.Literal("win")]), { maxItems: 4, description: "Keys held during the action." }));
const locatorTimeout = Type.Optional(Type.Integer({ minimum: 0, maximum: 60000, description: "How long a locator target may take to match one ready element, default 5000." }));
const PAGE_MODIFIERS: Record<string, string> = { ctrl: "Control", shift: "Shift", alt: "Alt", win: "Meta" };

type Endpoint = { target?: string; x?: number; y?: number };
/** The target or point of an action; required unless the action can go to the focused element. */
function aim(params: Endpoint, label: string, required: boolean): Pick<InputPlan, "target" | "point"> {
  if ((params.x === undefined) !== (params.y === undefined)) throw new ComputerRequestError(`${label} needs both x and y for a point.`);
  const point = params.x !== undefined ? { x: params.x, y: params.y! } : undefined;
  if (point && params.target !== undefined) throw new ComputerRequestError(`${label} takes a target or a point, not both.`);
  if (required && !point && params.target === undefined) throw new ComputerRequestError(`${label} needs a target or a point (x and y).`);
  return { ...(params.target !== undefined ? { target: params.target } : {}), ...(point ? { point } : {}) };
}
/** Fields every input plan shares. */
const shared = (params: { space?: "page" | "window" }) => ({ ...(params.space ? { space: params.space } : {}) });
const timeout = (params: { timeout_ms?: number }) => params.timeout_ms !== undefined ? { timeout_ms: params.timeout_ms } : {};
const pageModifiers = (modifiers?: string[]) => modifiers?.length ? { modifiers: modifiers.map(key => PAGE_MODIFIERS[key]) } : {};
/** A Playwright key name for a key the native tools also take, such as ctrl, return, up or f5. */
function pageKey(key: string): string {
  const lower = key.toLowerCase();
  return PAGE_MODIFIERS[lower === "control" ? "ctrl" : lower] ?? PAGE_KEYS[lower] ?? (/^f\d{1,2}$/.test(lower) ? lower.toUpperCase() : key);
}
/** A target inside a page timeline: a page ref, or a Playwright locator string. */
const pageTarget = (target: string) => refKind(target) === "page" ? { ref: target } : target;
/** A move of a page timeline to a point or to the centre of a target. */
const pageMove = (at_ms: number, to: { target?: string; point?: InputPoint }, steps?: number) =>
  ({ at_ms, type: "move", ...(to.target !== undefined ? { target: pageTarget(to.target) } : to.point), ...(steps ? { steps } : {}) });
/** Keys held around a page timeline's events. */
function holding(modifiers: string[] | undefined, start: number, end: number, events: Record<string, unknown>[]) {
  const keys = (modifiers ?? []).map(key => PAGE_MODIFIERS[key]);
  return [...keys.map(key => ({ at_ms: start, type: "key_down", key })), ...events, ...keys.reverse().map(key => ({ at_ms: end, type: "key_up", key }))];
}

const clickParameters = Type.Object({
  window: inputWindow, target: inputTarget("The element to click"), x: coordinate("Left"), y: coordinate("Top"), space: pointSpace,
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], { description: "Mouse button, default left." })),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "Clicks: 2 is a double click, 3 a triple click (browser pages). Default 1." })),
  modifiers: modifiersField, timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_click sends to a native window and to a browser page. */
export function clickPlan(params: Static<typeof clickParameters>): InputPlan {
  const count = params.count ?? 1, button = params.button ?? "left", modifiers = params.modifiers?.length ? { modifiers: params.modifiers } : {};
  const native = count === 3 ? "A triple click works on browser pages only."
    : button === "right" ? count === 2 ? "A right double click works on browser pages only." : { action: "right_click", ...modifiers, ...timeout(params) }
    : count === 2 ? button === "middle" ? "A middle double click works on browser pages only." : { action: "double_click", ...modifiers, ...timeout(params) }
    : { action: "click", ...(button === "middle" ? { button } : {}), ...modifiers, ...timeout(params) };
  const aimed = aim(params, "click", true);
  // A point of a page gets the presses Playwright's mouse.click sends, numbered so the page sees double and triple clicks.
  const presses = Array.from({ length: count }, (_, index) => [{ at_ms: 0, type: "button_down", button, click_count: index + 1 }, { at_ms: 0, type: "button_up", button, click_count: index + 1 }]).flat();
  return { label: "click", ...aimed, ...shared(params), native,
    web: aimed.point ? { action: "timeline", events: holding(params.modifiers, 0, 0, [pageMove(0, aimed), ...presses]) }
      : { action: "click", ...(button !== "left" ? { button } : {}), ...(count > 1 ? { click_count: count } : {}), ...pageModifiers(params.modifiers), ...timeout(params) } };
}

const hoverParameters = Type.Object({
  window: inputWindow, target: inputTarget("The element to point at"), x: coordinate("Left"), y: coordinate("Top"), space: pointSpace,
  dwell_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Native windows: how long the pointer rests there before the result, default 300." })),
  timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_hover sends; on a native window it moves the real pointer, so it runs in the foreground. */
export function hoverPlan(params: Static<typeof hoverParameters>): InputPlan {
  const aimed = aim(params, "hover", true);
  return { label: "hover", ...aimed, ...shared(params), native: { action: "hover", dwell_ms: params.dwell_ms ?? 300, ...timeout(params) },
    web: aimed.point ? { action: "timeline", events: [pageMove(0, aimed)] } : { action: "hover", ...timeout(params) } };
}

const endpoint = (what: string) => Type.Object({
  target: Type.Optional(Type.String({ description: `${what}: a ref from the window's latest Read, or a Playwright locator on browser pages.` })),
  x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false, description: `${what}: a target, or a point (x and y) in pixels of the window's latest image or CSS pixels of a browser page.` });
const dragParameters = Type.Object({
  window: inputWindow, from: endpoint("Where the drag starts"), to: endpoint("Where the drag ends"), space: pointSpace,
  via: Type.Optional(Type.Array(Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
    { minItems: 1, maxItems: 254, description: "Points the pointer passes through on the way, in order, for a path rather than a straight line; left button only." })),
  duration_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, description: "How long the move takes, default 500." })),
  button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], { description: "Button held during the drag, default left." })),
  modifiers: modifiersField,
}, { additionalProperties: false });

/** What computer_drag sends: a native drag, or a page timeline that presses, moves and releases. */
export function dragPlan(params: Static<typeof dragParameters>): InputPlan {
  const start = aim(params.from, "from", true), end = aim(params.to, "to", true);
  // On a page the drag is a timeline: press at the start, move through via to the end over duration_ms, release.
  const duration = params.duration_ms ?? 500, button = params.button ?? "left";
  const stops = [...(params.via ?? []).map(point => ({ point })), end];
  const steps = Math.max(1, Math.round(duration / stops.length / 16));
  const web = { action: "timeline", events: holding(params.modifiers, 0, duration, [pageMove(0, start), { at_ms: 0, type: "button_down", button },
    ...stops.map((stop, index) => pageMove(Math.round(duration * (index + 1) / stops.length), stop, steps)), { at_ms: duration, type: "button_up", button }]) };
  return { label: "drag", ...start, end, ...shared(params), web,
    native: { action: "drag", ...(params.duration_ms !== undefined ? { duration_ms: params.duration_ms } : {}), ...(params.button && params.button !== "left" ? { button: params.button } : {}),
      ...(params.modifiers?.length ? { modifiers: params.modifiers } : {}), ...(params.via ? { via: params.via } : {}) } };
}

const scrollParameters = Type.Object({
  window: inputWindow, target: inputTarget("The element to scroll; omit for the middle of the window or page"), x: coordinate("Left"), y: coordinate("Top"), space: pointSpace,
  delta_x: Type.Optional(Type.Integer({ minimum: -50, maximum: 50, description: "Wheel notches to the right (negative: left)." })),
  delta_y: Type.Optional(Type.Integer({ minimum: -50, maximum: 50, description: "Wheel notches down (negative: up). One notch scrolls about 100 CSS pixels in a browser; apps decide their own distance." })),
  timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_scroll sends: wheel notches at a point, or an accessibility scroll of a native element target. */
export function scrollPlan(params: Static<typeof scrollParameters>): InputPlan {
  const dx = params.delta_x ?? 0, dy = params.delta_y ?? 0;
  if (!dx && !dy) throw new ComputerRequestError("scroll needs delta_x or delta_y.");
  const aimed = aim(params, "scroll", false);
  const native = aimed.target === undefined ? { action: "scroll", ...(dx ? { delta_x: dx } : {}), ...(dy ? { delta_y: dy } : {}), unit: "wheel_detents" }
    : dx && dy ? "Scroll a native element along one axis at a time, or give a point."
    : { action: "scroll", direction: dy > 0 ? "down" : dy < 0 ? "up" : dx > 0 ? "right" : "left", amount: Math.abs(dx || dy), ...timeout(params) };
  return { label: "scroll", ...aimed, ...shared(params), native,
    web: aimed.point ? { action: "timeline", events: [pageMove(0, aimed), { at_ms: 0, type: "wheel", ...(dx ? { dx: dx * 100 } : {}), ...(dy ? { dy: dy * 100 } : {}) }] }
      : { action: "scroll", ...(dx ? { delta_x: dx * 100 } : {}), ...(dy ? { delta_y: dy * 100 } : {}), ...timeout(params) } };
}

const typeParameters = Type.Object({
  window: inputWindow, text: Type.String({ maxLength: 20000, description: "Text to type, as is: newlines and quotes stay text. Native windows take up to 2000 characters and get real key presses, so the window comes to the front; replace sets the value through UI Automation instead." }),
  target: inputTarget("The field to type into; omit for the focused element"), space: pointSpace,
  replace: Type.Optional(Type.Boolean({ description: "Replace the field's whole value instead of typing at the caret; needs target." })),
  submit: Type.Optional(Type.Boolean({ description: "Press Enter after the text." })),
  delay_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "Native windows: pause between characters." })),
  timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_type sends, with Enter as a second step when submit is set. */
export function typePlan(params: Static<typeof typeParameters>): InputPlan {
  if (params.replace && params.target === undefined) throw new ComputerRequestError("replace needs the field as target.");
  // Enter goes to the same field: a semantic replace does not move the keyboard focus there.
  const enter: InputPlan = { label: "submit", ...(params.target !== undefined ? { target: params.target } : {}), ...shared(params), native: { action: "key", key: "return", ...timeout(params) }, web: { action: "press", key: "Enter", ...timeout(params) } };
  return { label: "type", ...aim(params, "type", false), ...shared(params),
    native: params.replace ? { action: "set_value", text: params.text, ...timeout(params) } : { action: "type_text", text: params.text, ...(params.delay_ms !== undefined ? { delay_ms: params.delay_ms } : {}), ...timeout(params) },
    web: params.delay_ms !== undefined ? "delay_ms applies to native windows." : { action: params.replace ? "fill" : "type", text: params.text, ...timeout(params) },
    ...(params.submit ? { then: enter } : {}) };
}

const pressParameters = Type.Object({
  window: inputWindow, key: Type.String({ maxLength: 64, description: "A key with optional modifiers joined by +, such as Enter, ctrl+s, shift+Tab, F5, ArrowDown or a. Native windows get real key presses, so the window comes to the front." }),
  target: inputTarget("The element to focus first; omit for the focused element"), space: pointSpace,
  hold_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Native windows: hold the keys down this long, for apps and games that read held keys." })),
}, { additionalProperties: false });
const PAGE_KEYS: Record<string, string> = { enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", del: "Delete",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", pgup: "PageUp", pgdn: "PageDown" };

/** What computer_press sends: one key or chord, or keys held for hold_ms on a native window. */
export function pressPlan(params: Static<typeof pressParameters>): InputPlan {
  const parts = params.key.split("+").map(part => part.trim());
  if (parts.some(part => !part)) throw new ComputerRequestError("key joins a key and its modifiers with +, such as ctrl+s.");
  const key = parts.at(-1)!, held = parts.slice(0, -1).map(part => part.toLowerCase().replace(/^(control)$/, "ctrl").replace(/^(meta|windows|cmd)$/, "win"));
  if (held.some(part => !PAGE_MODIFIERS[part])) throw new ComputerRequestError("Modifiers are ctrl, shift, alt and win.");
  const native = params.hold_ms !== undefined ? { action: "hold", keys: [...held, key.toLowerCase()], duration_ms: params.hold_ms }
    // A chord goes as a hotkey: posted key messages do not carry modifier state, so the app would see the bare key.
    : held.length ? { action: "hotkey", keys: [...held, key.toLowerCase()] } : { action: "key", key: key.toLowerCase() };
  const keys = [...held.map(part => PAGE_MODIFIERS[part]), pageKey(key)];
  const aimed = aim(params, "press", false);
  if (params.hold_ms !== undefined && aimed.target !== undefined) throw new ComputerRequestError("hold_ms goes to the focused element; focus it with computer_click first.");
  return { label: "press", ...aimed, ...shared(params), native,
    web: params.hold_ms !== undefined ? { action: "timeline", events: [...keys.map(name => ({ at_ms: 0, type: "key_down", key: name })), ...[...keys].reverse().map(name => ({ at_ms: params.hold_ms!, type: "key_up", key: name }))] }
      : { action: "press", key: keys.join("+") } };
}

const selectParameters = Type.Object({
  window: inputWindow, target: inputTarget("The list, select, checkbox or option; not used with menu"), space: pointSpace,
  values: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 64, description: "Options to choose in the target list, by label or value. Native lists take one; omit values to select the target option itself." })),
  checked: Type.Optional(Type.Boolean({ description: "Set the target checkbox, radio or toggle to checked (true) or unchecked (false); nothing is sent when it already is." })),
  menu: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 16, description: "Native windows: menu labels from the menu bar to the item, such as [\"File\", \"Save As...\"]." })),
  timeout_ms: locatorTimeout,
}, { additionalProperties: false });

/** What computer_select sends: options of a list, a checked state, or a menu item. */
export function selectPlan(params: Static<typeof selectParameters>): InputPlan {
  const chosen = [params.values && "values", params.checked !== undefined && "checked", params.menu && "menu"].filter(Boolean);
  if (chosen.length > 1) throw new ComputerRequestError(`select takes one of values, checked or menu, not ${chosen.join(" and ")}.`);
  if (params.menu) {
    if (params.target !== undefined) throw new ComputerRequestError("menu names its item by path; omit target.");
    return { label: "select", ...shared(params), native: { action: "menu", path: params.menu }, web: "menu works on native windows; use a target on browser pages." };
  }
  if (params.target === undefined) throw new ComputerRequestError("select needs a target.");
  const base = { label: "select", target: params.target, ...shared(params) };
  if (params.checked !== undefined) return { ...base, native: { action: params.checked ? "check" : "uncheck", ...timeout(params) }, web: { action: params.checked ? "check" : "uncheck", ...timeout(params) } };
  if (params.values) return { ...base, native: params.values.length > 1 ? "A native list takes one value at a time." : { action: "select", option: params.values[0], ...timeout(params) },
    web: { action: "select", values: params.values, ...timeout(params) } };
  return { ...base, native: { action: "select", ...timeout(params) }, web: "Give values: the options to choose in this select element." };
}

const timelineParameters = Type.Object({
  window: inputWindow, space: pointSpace,
  events: Type.Array(Type.Object({
    at_ms: Type.Integer({ minimum: 0, maximum: 120000, description: "Time from the start; never decreases." }),
    type: Type.Union([Type.Literal("key_down"), Type.Literal("key_up"), Type.Literal("button_down"), Type.Literal("button_up"), Type.Literal("move"), Type.Literal("move_relative"), Type.Literal("wheel"), Type.Literal("pen_down"), Type.Literal("pen_move"), Type.Literal("pen_up")]),
    key: Type.Optional(Type.String({ description: "key_down, key_up." })),
    button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle"), Type.Literal("x1"), Type.Literal("x2")], { description: "button_down, button_up; default left." })),
    x: Type.Optional(Type.Number({ minimum: 0, description: "move and pen events: pixels of the window's latest image." })),
    y: Type.Optional(Type.Number({ minimum: 0 })),
    dx: Type.Optional(Type.Integer({ description: "move_relative: raw mouse counts; wheel: notches." })),
    dy: Type.Optional(Type.Integer()),
    pressure: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Pen events." })),
    tilt_x: Type.Optional(Type.Integer({ minimum: -90, maximum: 90 })), tilt_y: Type.Optional(Type.Integer({ minimum: -90, maximum: 90 })),
    eraser: Type.Optional(Type.Boolean()), barrel: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 5000, description: "Timed events. Every key and button pressed must be released; anything still held is released when the call ends." }),
}, { additionalProperties: false });

/** What computer_timeline sends: native events in the foreground, or page events in CSS pixels through Playwright and CDP. */
export function timelinePlan(params: Static<typeof timelineParameters>): InputPlan {
  const native = params.events.find(event => event.type === "move_relative" || event.eraser || event.barrel || event.button === "x1" || event.button === "x2");
  const web = native ? `${native.type === "move_relative" ? "move_relative" : native.eraser ? "The pen eraser" : native.barrel ? "The pen barrel button" : `Button ${native.button}`} needs native input: give space: "window" and points in pixels of the window's latest image.`
    : { action: "timeline", events: params.events.map(({ eraser: _eraser, barrel: _barrel, ...event }) => ({ ...event,
      ...(event.key !== undefined ? { key: pageKey(event.key) } : {}),
      ...(event.type === "wheel" ? { ...(event.dx ? { dx: event.dx * 100 } : {}), ...(event.dy ? { dy: event.dy * 100 } : {}) } : {}) })) };
  return { label: "timeline", ...shared(params), native: { action: "timeline", events: params.events }, web };
}
/**
 * Register the typed computer_* tools, one per operation cluster. They are deferred: a
 * tool_search for computer loads them, so sessions that never use the computer pay nothing for them.
 */
export function registerComputerTools(pi: ExtensionAPI, resources: ComputerResources): void {
  const namespace = computerNamespace();
  const common = { exposure: "deferred" as const, namespace, outputSchema: receiptSchema };
  const rendered = (name: string, call: (args: Record<string, unknown>) => string) => ({
    renderCall: (args: unknown) => new Text(`${name} ${plain(call(args as Record<string, unknown>))}`, 0, 0),
    renderResult: computerActionRenderer(name).renderResult,
  });
  pi.registerTool({
    ...common, name: "computer_open", label: "Computer open",
    description: "Use computer_open to start an app, a Playwright browser, a Windows Sandbox or an isolated session on a machine, or to attach Playwright to a running browser window. The result gives the new window or sandbox address.",
    parameters: openParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_open", args => [args.at, args.app ?? args.path ?? args.url ?? args.browser ?? (args.sandbox ? "sandbox" : args.isolated_session ? "isolated session" : "")].filter(Boolean).join(" ")),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.at, "open", () => {
        const address = resources.address(params.at);
        command = openCommand(address, params);
        return address;
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_window", label: "Computer window",
    description: "Use computer_window to move, resize, maximize, minimize, focus or restore an app window by its address without keys or clicks, or to give it a short name.",
    parameters: windowParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_window", args => `${args.window} ${args.action}${args.action === "move" ? ` ${args.x},${args.y}` : args.action === "resize" ? ` ${args.width}x${args.height}` : args.action === "name" ? ` ${args.as}` : ""}`),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.window, params.action, () => {
        command = windowCommand(params);
        return resources.address(params.window);
      }, address => command.action === "name" ? resources.name(address, ctx.cwd, command.as, signal) : resources.manageWindow(address, ctx.cwd, command, signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_wait", label: "Computer wait",
    description: "Use computer_wait to wait until a window's UI or a browser page meets conditions, or to check them once, without sending input. The last sample becomes the window's current observation.",
    parameters: waitParameters,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_wait", args => `${args.window} ${args.mode ?? "wait"} ${(args.conditions as unknown[] | undefined)?.length ?? 0} condition(s)`),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.window, params.mode === "check" ? "verify" : "wait_for", () => {
        command = waitCommand(params);
        const address = resources.address(params.window);
        if (address.kind !== "window") throw new ComputerRequestError("computer_wait needs a window address from Search, Read or a name.");
        return address;
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_browser", label: "Computer browser",
    description: "Use computer_browser to navigate, manage tabs, answer JavaScript dialogs, upload or download files, and run page JavaScript in a browser window. The result shows the page's fresh snapshot.",
    parameters: browserParameters,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    ...rendered("computer_browser", args => `${args.window} ${args.action}${args.url ? ` ${args.url}` : args.tab ? ` ${args.tab}` : ""}`),
    async execute(_id, params, signal, _update, ctx) {
      const { window, ...command } = params;
      return actionResult(await computerAction(resources, window, params.action, () => resources.address(window),
        address => resources.browserAction(address, ctx.cwd, command, signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_files", label: "Computer files",
    description: "Use computer_files to copy files between the workspace and this session's own folder on a machine, or to list that folder, so apps there can open or save them.",
    parameters: filesParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_files", args => `${args.machine} ${args.action}${args.from ? ` ${args.from}` : args.name ? ` ${args.name}` : ""}`),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.machine, params.action, () => {
        command = filesCommand(params);
        return machineAddress(resources, params.machine);
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_clipboard", label: "Computer clipboard",
    description: "Use computer_clipboard to read or replace a machine's clipboard in YOLO mode, with text or an image.",
    parameters: clipboardParameters,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    ...rendered("computer_clipboard", args => `${args.machine} ${args.action}${args.image ? ` ${args.image}` : ""}`),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.machine, `clipboard_${params.action}`, () => {
        command = clipboardCommand(params);
        return machineAddress(resources, params.machine);
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_record", label: "Computer record",
    description: "Use computer_record to record a machine's display to video or its playback audio, or to capture frames of a window or display over time for motion and animation.",
    parameters: recordParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_record", args => `${args.at} ${args.action}${args.seconds ? ` ${args.seconds} s` : args.duration_ms ? ` ${args.duration_ms} ms` : ""}`),
    async execute(_id, params, signal, _update, ctx) {
      let run: ReturnType<typeof recordCommand> = { command: {} };
      return actionResult(await computerAction(resources, params.at, params.action, () => {
        run = recordCommand(params);
        if ("views" in run) {
          const address = resources.address(params.at);
          if (address.kind !== "window" && address.kind !== "display") throw new ComputerRequestError("sequence captures a window or display address.");
          return address;
        }
        return machineAddress(resources, params.at);
      }, async address => "views" in run
        ? (await resources.sequence(address, ctx.cwd, run.views, signal))!
        : resources.perform(address, ctx.cwd, JSON.stringify(run.command), signal)));
    },
  });
  /** Run one typed input on a window: the plan is built and checked before anything reaches the machine. */
  const input = async (window: string, action: string, build: () => InputPlan, cwd: string, signal?: AbortSignal) => {
    let plan: InputPlan | undefined;
    return actionResult(await computerAction(resources, window, action, () => { plan = build(); return resources.address(window); },
      address => resources.input(address, cwd, plan!, signal)));
  };
  const aimed = (args: Record<string, unknown>) => args.target !== undefined ? String(args.target) : args.x !== undefined ? `${args.x},${args.y}` : "";
  const inputAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  pi.registerTool({
    ...common, name: "computer_click", label: "Computer click",
    description: "Use computer_click to click an element or a point of a window: any button, double or triple clicks, with modifier keys. The result lists what changed.",
    parameters: clickParameters, annotations: inputAnnotations,
    ...rendered("computer_click", args => `${args.window} ${aimed(args)}${args.count ? ` x${args.count}` : ""}${args.button && args.button !== "left" ? ` ${args.button}` : ""}`),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "click", () => clickPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_hover", label: "Computer hover",
    description: "Use computer_hover to rest the pointer on an element or a point without clicking, for tooltips, hover menus and hover states.",
    parameters: hoverParameters, annotations: inputAnnotations,
    ...rendered("computer_hover", args => `${args.window} ${aimed(args)}`),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "hover", () => hoverPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_drag", label: "Computer drag",
    description: "Use computer_drag to press a button at one element or point, move to another, optionally through a path, and release there, for sliders, drag and drop and drawing.",
    parameters: dragParameters, annotations: inputAnnotations,
    ...rendered("computer_drag", args => `${args.window} ${aimed(args.from as Record<string, unknown>)} → ${aimed(args.to as Record<string, unknown>)}`),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "drag", () => dragPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_scroll", label: "Computer scroll",
    description: "Use computer_scroll to turn the mouse wheel over an element, a point or the middle of a window or page.",
    parameters: scrollParameters, annotations: inputAnnotations,
    ...rendered("computer_scroll", args => `${args.window} ${aimed(args)} ${args.delta_x ?? 0},${args.delta_y ?? 0}`),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "scroll", () => scrollPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_type", label: "Computer type",
    description: "Use computer_type to type text into a field or the focused element, or to replace a field's value, optionally pressing Enter after it.",
    parameters: typeParameters, annotations: inputAnnotations,
    ...rendered("computer_type", args => `${args.window} ${aimed(args)} ${String(args.text ?? "").length} chars${args.submit ? " + Enter" : ""}`),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "type", () => typePlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_press", label: "Computer press",
    description: "Use computer_press to press a key or shortcut such as Enter or ctrl+s, or to hold keys down for a time.",
    parameters: pressParameters, annotations: inputAnnotations,
    ...rendered("computer_press", args => `${args.window} ${args.key}${args.hold_ms ? ` for ${args.hold_ms} ms` : ""}`),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "press", () => pressPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_select", label: "Computer select",
    description: "Use computer_select to choose options in a list or select element, set a checkbox, radio or toggle, or open an app's menu item.",
    parameters: selectParameters, annotations: inputAnnotations,
    ...rendered("computer_select", args => `${args.window} ${args.menu ? (args.menu as string[]).join(" > ") : `${args.target ?? ""} ${args.values ? (args.values as string[]).join(", ") : args.checked !== undefined ? (args.checked ? "checked" : "unchecked") : ""}`}`),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "select", () => selectPlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_timeline", label: "Computer timeline",
    description: "Use computer_timeline to play timed key, button, pointer, wheel and pen events in one call, for games, held keys across moves and pressure-sensitive strokes.",
    parameters: timelineParameters, annotations: inputAnnotations,
    ...rendered("computer_timeline", args => `${args.window} ${(args.events as unknown[] | undefined)?.length ?? 0} events`),
    async execute(_id, params, signal, _update, ctx) { return input(params.window, "timeline", () => timelinePlan(params), ctx.cwd, signal); },
  });
  pi.registerTool({
    ...common, name: "computer_display", label: "Computer display",
    description: "Use computer_display to change a display's resolution in YOLO mode, for example to test an app at another size; closing computer use restores it.",
    parameters: displayParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_display", args => `${args.display} ${args.width}x${args.height}`),
    async execute(_id, params, signal, _update, ctx) {
      return actionResult(await computerAction(resources, params.display, "resize", () => resources.address(params.display),
        address => resources.perform(address, ctx.cwd, JSON.stringify({ action: "resize", width: params.width, height: params.height }), signal)));
    },
  });
}

/** Delete for computer resources when Pi Agent IDE is absent: the IDE's Delete handles them otherwise. */
export function registerComputerDelete(pi: ExtensionAPI, resources: ComputerResources): void {
  pi.registerTool({
    name: "computer_delete", label: "Computer delete", exposure: "deferred", namespace: computerNamespace(), outputSchema: receiptSchema,
    description: "Use computer_delete to close an app window, or to release a sandbox, isolated session, machine or all of computer use.",
    parameters: Type.Object({ path: Type.String({ description: COMPUTER_DELETE_HELP }) }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    renderCall: args => new Text(`computer_delete ${plain(args.path)}`, 0, 0),
    renderResult: computerActionRenderer("computer_delete").renderResult,
    async execute(_id, params, signal, _update, ctx) {
      return actionResult(await deleteComputer(resources, params.path, params, ctx.cwd, signal));
    },
  });
}
