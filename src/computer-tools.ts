import { Type, type JsonValue, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ComputerRequestError, type ComputerResources } from "./computer-resources.ts";
import type { ComputerAddress } from "./computer-address.ts";
import { computerActionRenderer } from "./computer-action-renderer.ts";
import { parseComputerViews } from "./computer-views.ts";
import { COMPUTER_DELETE_HELP, computerAction, deleteComputer } from "./provider.ts";

const plain = (value: unknown) => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
type Action = Awaited<ReturnType<typeof computerAction>>;

/** The namespace every computer_* tool shares; tool_search finds them by it, and its instructions are the guide. */
export function computerNamespace(guide: string) {
  return { name: "computer", description: "Read and operate Windows app windows, displays and browser pages through computer: addresses", instructions: guide };
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
}, { additionalProperties: false });

/** The Insert command that opens what computer_open asks for at this address. */
export function openCommand(address: ComputerAddress, params: Static<typeof openParameters>): Record<string, unknown> {
  const { app, path, args, debugging, browser, url, profile, sandbox, isolated_session } = params;
  const chosen = [app !== undefined && "app", path !== undefined && "path", (browser ?? url ?? profile) !== undefined && "browser",
    sandbox !== undefined && "sandbox", isolated_session === true && "isolated_session"].filter(Boolean);
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
  throw new ComputerRequestError("Name what to open: app, path, browser or url, sandbox, or isolated_session.");
}

const windowParameters = Type.Object({
  window: Type.String({ description: "Window address from Search, Read or a name, such as computer:zinpc/w3qk or computer:game." }),
  action: Type.Union([Type.Literal("move"), Type.Literal("resize"), Type.Literal("maximize"), Type.Literal("minimize"), Type.Literal("focus"), Type.Literal("restore")],
    { description: "focus activates a visible window; restore brings a minimized window back and activates it." }),
  x: Type.Optional(Type.Integer({ description: "move: new left edge in Windows desktop pixels." })),
  y: Type.Optional(Type.Integer({ description: "move: new top edge in Windows desktop pixels." })),
  width: Type.Optional(Type.Integer({ minimum: 1, description: "resize: new width in Windows desktop pixels." })),
  height: Type.Optional(Type.Integer({ minimum: 1, description: "resize: new height in Windows desktop pixels." })),
}, { additionalProperties: false });

/** The window management command of computer_window. */
export function windowCommand(params: Static<typeof windowParameters>): Record<string, unknown> {
  const { window: _window, action, ...fields } = params;
  const wanted = action === "move" ? ["x", "y"] : action === "resize" ? ["width", "height"] : [];
  const given = Object.keys(fields);
  if (given.some(key => !wanted.includes(key)) || wanted.some(key => !given.includes(key)))
    throw new ComputerRequestError(wanted.length ? `${action} needs ${wanted.join(" and ")} and nothing else.` : `${action} takes no coordinates or size.`);
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

/** The Insert wait_for or verify command of computer_wait. */
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

/**
 * Register the typed computer_* tools that replace Insert commands one cluster at a time. They are deferred: a
 * tool_search for computer loads them, so sessions that never use the computer pay nothing for them.
 */
export function registerComputerTools(pi: ExtensionAPI, resources: ComputerResources, guide: string): void {
  const namespace = computerNamespace(guide);
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
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), "insert", signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_window", label: "Computer window",
    description: "Use computer_window to move, resize, maximize, minimize, focus or restore an app window by its address, without keys or clicks.",
    parameters: windowParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_window", args => `${args.window} ${args.action}${args.action === "move" ? ` ${args.x},${args.y}` : args.action === "resize" ? ` ${args.width}x${args.height}` : ""}`),
    async execute(_id, params, signal, _update, ctx) {
      let command: Record<string, unknown> = {};
      return actionResult(await computerAction(resources, params.window, params.action, () => {
        command = windowCommand(params);
        return resources.address(params.window);
      }, address => resources.manageWindow(address, ctx.cwd, command, signal)));
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
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), "insert", signal)));
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
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), "insert", signal)));
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
      }, address => resources.perform(address, ctx.cwd, JSON.stringify(command), "insert", signal)));
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
        ? (await resources.read(address, ctx.cwd, run.views, signal))!
        : resources.perform(address, ctx.cwd, JSON.stringify(run.command), "insert", signal)));
    },
  });
  pi.registerTool({
    ...common, name: "computer_display", label: "Computer display",
    description: "Use computer_display to change a display's resolution in YOLO mode, for example to test an app at another size; closing computer use restores it.",
    parameters: displayParameters,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    ...rendered("computer_display", args => `${args.display} ${args.width}x${args.height}`),
    async execute(_id, params, signal, _update, ctx) {
      return actionResult(await computerAction(resources, params.display, "resize", () => resources.address(params.display),
        address => resources.perform(address, ctx.cwd, JSON.stringify({ action: "resize", width: params.width, height: params.height }), "insert", signal)));
    },
  });
}

/** Delete for computer resources when Pi Agent IDE is absent: the IDE's Delete handles them otherwise. */
export function registerComputerDelete(pi: ExtensionAPI, resources: ComputerResources, guide: string): void {
  pi.registerTool({
    name: "computer_delete", label: "Computer delete", exposure: "deferred", namespace: computerNamespace(guide), outputSchema: receiptSchema,
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
