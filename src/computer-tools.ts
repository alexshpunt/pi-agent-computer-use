import { Type, type JsonValue, type Static } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ComputerRequestError, type ComputerResources } from "./computer-resources.ts";
import type { ComputerAddress } from "./computer-address.ts";
import { computerActionRenderer } from "./computer-action-renderer.ts";
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
