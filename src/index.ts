import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "./config.ts";
import { McpDriver } from "./driver.ts";
import { registerComputerMode } from "./mode.ts";
import { ComputerSession, type ComputerResult } from "./session.ts";

/** Register standalone window tools against an owned session factory. The caller owns shutdown. */
export function registerComputerTools(pi: ExtensionAPI, getSession: (cwd: string) => Promise<ComputerSession>,
  closeSession: () => Promise<ComputerResult>): void {
  pi.registerTool({
    name: "computer_apps", label: "Computer apps",
    description: "Find installed Windows apps by optional query. Returns exact app names/app_id for computer_open. No app is launched.",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).apps(signal, params.query); },
  });
  pi.registerTool({
    name: "computer_open", label: "Computer open",
    description: "Open a genuinely NEW installed Windows app window by exact app name or computer_apps app_id. Returns window_ref plus first accessibility observation and screenshot, ready for one action. No PID/HWND, target config, shell tool, or reload. Opening is attempted once; reuse of an existing window/tab is not success. Unknown means discover before deciding; never blindly relaunch. Safe permits only session-opened windows; YOLO permits desktop-wide UI access. Neither is an OS sandbox.",
    parameters: Type.Object({ app: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).open(params.app, signal); },
  });
  pi.registerTool({
    name: "computer_windows", label: "Computer windows",
    description: "Discover permitted Windows desktop windows (Safe: only session-opened; YOLO: also already open), optionally filtered by app/title. Returns session window_ref identities and metadata, not UI contents. Use returned refs for observation/actions. A closed/reused HWND cannot keep an old ref. No app is launched.",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).windows(signal, params.query); },
  });
  pi.registerTool({
    name: "computer_observe", label: "Computer observe",
    description: "Read a session window_ref's current accessibility tree and screenshot together. Returns observation_id and element_token references. Only this window's previous observation expires. Use both tree and pixels; ground one action, then read again. Safe denies outside-session windows even with old refs; YOLO permits them. Only the user can change mode with /computer-mode. No IDE dependency.",
    parameters: Type.Object({
      window_ref: Type.String({ minLength: 1 }),
      query: Type.Optional(Type.String({ description: "Project the tree to matching labels/values and ancestors." })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).observe(params.window_ref, signal, params.query); },
  });
  pi.registerTool({
    name: "computer_act", label: "Computer act",
    description: "Perform one grounded action on window_ref using its latest observation_id. Each dispatch consumes that observation, even on failure. Use its element_token or scoped screenshot x/y. type_text inputs text; set_value replaces an element value; select_all sends Ctrl+A. Background is default. Foreground must be explicit and only after an observed failure/refusal. Unknown may have changed the app: never blindly retry. Observe to verify. Safe denies outside-session windows; YOLO permits them. Mode is a user choice, not a tool argument. Neither is OS isolation. Use only task-authorized windows/documents.",
    parameters: Type.Object({
      window_ref: Type.String({ minLength: 1 }),
      observation_id: Type.String({ minLength: 1 }),
      action: Type.Union(["type_text", "set_value", "click", "select_all", "key"].map(value => Type.Literal(value))),
      delivery_mode: Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("foreground")])),
      element_token: Type.Optional(Type.String({ minLength: 1 })),
      x: Type.Optional(Type.Number({ minimum: 0 })), y: Type.Optional(Type.Number({ minimum: 0 })),
      text: Type.Optional(Type.String({ maxLength: 2000 })),
      key: Type.Optional(Type.Union(["backspace", "delete", "left", "right", "home", "end", "return", "escape", "tab"].map(value => Type.Literal(value)))),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).act(params, signal); },
  });
  pi.registerTool({
    name: "computer_close", label: "Computer close",
    description: "Release this session's Driver and window-identity peer, invalidate window/observation refs. Does not close application windows or save documents. Clean up task-owned windows through grounded UI actions first.",
    parameters: Type.Object({}, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute() { return closeSession(); },
  });
}

/** Standalone computer UI extension. The final Pi Agent IDE provider API remains separate. */
export default function computerUse(pi: ExtensionAPI): void {
  const getMode = registerComputerMode(pi);
  let session: ComputerSession | undefined;
  let loading: Promise<ComputerSession> | undefined;
  async function getSession(cwd: string): Promise<ComputerSession> {
    if (session) return session;
    if (!loading) loading = loadComputerConfig(cwd).then(config => {
      session = new ComputerSession(new McpDriver(config), getMode);
      return session;
    });
    try { return await loading; }
    finally { loading = undefined; }
  }
  registerComputerTools(pi, getSession, async () => session ? session.close() : {
    content: [{ type: "text", text: "No owned computer-use runtime is running." }],
    details: { status: "closed", mode: getMode() },
  });
  pi.on("session_shutdown", async () => {
    if (loading) await loading.catch(() => undefined);
    await session?.close();
    session = undefined;
  });
}
