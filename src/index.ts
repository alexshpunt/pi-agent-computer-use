import { Type } from "@earendil-works/pi-ai";
import { actionParameters } from "./complete-input.ts";
import { registerVisionDebug } from "./vision-debug.ts";
import { CuaImageSettings } from "./cua-image-settings.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadComputerConfig } from "./config.ts";
import { McpDriver } from "./driver.ts";
import { registerComputerMode } from "./mode.ts";
import { WindowHighlights } from "./window-highlights.ts";
import { ComputerSession, type ComputerResult, type Action } from "./session.ts";

/** Register standalone window tools against an owned session factory. The caller owns shutdown. */
export function registerComputerTools(pi: ExtensionAPI, getSession: (cwd: string) => Promise<ComputerSession>,
  closeSession: () => Promise<ComputerResult>): void {
  pi.registerTool({
    name: "computer_apps", label: "Computer apps",
    description: "Find installed Windows apps by optional query. Returns exact app names/app_id for computer_open. No app is launched. In Codemode, save the chosen app_id with store under a short task name and reuse it with load; do not retype returned IDs.",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).apps(signal, params.query); },
  });
  pi.registerTool({
    name: "computer_open", label: "Computer open",
    description: "Open a genuinely NEW installed Windows app window by exact app name or computer_apps app_id. Returns window_ref plus first accessibility observation and screenshot, ready for one complete action or bounded keyboard/stroke sequence. No PID/HWND, target config, shell tool, or reload. Opening is attempted once; reuse of an existing window/tab is not success. Unknown means discover before deciding; never blindly relaunch. Safe permits only session-opened windows; YOLO permits desktop-wide UI access. Neither is an OS sandbox. In Codemode, save returned window_ref and current observation_id, element_tokens and agent_image.image_id with store under a short task name; reuse them with load, not copied ID literals. Store only compact references, not images or whole results.",
    parameters: Type.Object({ app: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).open(params.app, signal); },
  });
  pi.registerTool({
    name: "computer_windows", label: "Computer windows",
    description: "Discover permitted Windows desktop windows (Safe: only session-opened; YOLO: also already open), optionally filtered by app/title. Returns session window_ref identities and metadata, not UI contents. Use returned refs for observation/actions. A closed/reused HWND cannot keep an old ref. No app is launched. In Codemode, store the chosen window_ref under a short task name and reuse it with load; do not retype returned IDs.",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).windows(signal, params.query); },
  });
  pi.registerTool({
    name: "computer_observe", label: "Computer observe",
    outputSchema: Type.Object({
      status: Type.String(), text: Type.String(), source: Type.Optional(Type.Unknown()),
      image: Type.Optional(Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() })),
    }, { additionalProperties: true }),
    description: "Observe exactly one Windows source: window_ref for its accessibility tree and native window PNG, or display: primary for a read-only full-primary-display PNG in YOLO. Native images use shared Vision settings (default 500px); returned source metadata separates Windows image geometry from browser page semantics. Display reading and detail are read-only and forbidden in Safe. zoom uses the latest agent_image.image_id plus a rectangle in its returned PNG. Window detail is native padded JPEG; display detail crops a fresh full-resolution native capture above CUA. Details cannot nest or ground input; take a fresh overview before acting. Window observations return observation_id/element_token for one complete action or bounded keyboard/stroke sequence. Closed/reused references refuse. No fallback to desktop, automatic foregrounding or paint-readiness guarantee. Only the user can change mode. In Codemode, load the stored window_ref and replace stored observation_id, element_tokens and agent_image.image_id after each successful overview. Keep only compact references in store, not screenshots or whole results. Storage does not extend ID lifetime; detail consumes its overview.",
    parameters: Type.Object({
      window_ref: Type.Optional(Type.String({ minLength: 1 })),
      display: Type.Optional(Type.String({ description: "Only primary is supported; display reading is YOLO-only and grants no input." })),
      query: Type.Optional(Type.String({ description: "Project the tree to matching labels/values and ancestors; cannot combine with zoom." })),
      zoom: Type.Optional(Type.Object({
        image_id: Type.String({ minLength: 1, description: "agent_image.image_id from the latest overview of this source, not a detail." }),
        x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }),
        width: Type.Number({ exclusiveMinimum: 0 }), height: Type.Number({ exclusiveMinimum: 0 }),
        maxLongEdge: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096, description: "Display detail only; default 1200. CUA window zoom keeps native JPEG padding and 500px width." })),
        scale: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1, description: "Display detail only; default 1. Does not change overview settings." })),
      }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      if ((params.window_ref !== undefined) === (params.display !== undefined) || (params.display !== undefined && params.query !== undefined) || (params.zoom !== undefined && params.query !== undefined))
        return { content: [{ type: "text" as const, text: "Choose exactly one window_ref or display: primary. query is window-only and cannot combine with zoom." }], details: { status: "refused" }, isError: true };
      const current = await getSession(ctx.cwd);
      const result = await (params.display !== undefined ? current.observeDisplay(params.display, signal, params.zoom) : current.observe(params.window_ref!, signal, params.query, params.zoom));
      const image = result.content.find(block => block.type === "image");
      return { ...result, structuredContent: JSON.parse(JSON.stringify({ ...result.details,
        text: result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), ...(image ? { image } : {}) })) };
    },
  });
  pi.registerTool({
    name: "computer_act", label: "Computer act",
    description: "Perform a complete grounded window action, or one bounded sequence, using the latest observation_id. Dispatch consumes the observation even on failure. Use its element_token or window-local screenshot x/y. Supports click/right_click/double_click, scroll (observed element_token only; no pixel scroll), straight drag, key/hotkey, type_text (delay_ms), set_value and select_all. Drag endpoints are from_x/from_y/to_x/to_y; duration_ms 0..10000 and steps 1..200. sequence accepts 1..32 known-target key/hotkey/type_text/select_all/drag steps, wait_ms 0..5000 each, up to 30s requested time and 45s elapsed admission budget. Entire list is validated before input; serial execution needs no intermediate overview. Each drag releases the button; no held-input state, hover or continuous curves. Stops on refusal/unknown/cancel/access or target loss, reporting actual attempted/completed prefix and dispatch/completion timings; never replay that prefix. In-flight native input may finish after cancellation. Delivery is not UI verification. Background is default. Foreground must be explicit and only after an observed failure/refusal. Unknown may have changed the app: never blindly retry. Observe to verify. Safe denies outside-session windows; YOLO permits them. Mode is a user choice, not a tool argument. Neither is OS isolation. Use only task-authorized windows/documents. In Codemode, load window_ref and current observation/target IDs from store instead of retyping them. Invalidate stored observation_id and element_tokens after every dispatch, even on failure; observe again and store fresh IDs before another action or sequence.",
    parameters: actionParameters,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) { return (await getSession(ctx.cwd)).act(params as Action, signal); },
  });
  pi.registerTool({
    name: "computer_close", label: "Computer close",
    description: "Release this session's Driver and window-identity peer, invalidate window/observation refs. Does not close application windows or save documents. Clean up task-owned windows through grounded UI actions first. Discard saved window/observation/token/image IDs in Codemode storage after release; rediscover windows before saving new references.",
    parameters: Type.Object({}, { additionalProperties: false }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute() { return closeSession(); },
  });
}

/** Standalone computer UI extension. The final Pi Agent IDE provider API remains separate. */
export default function computerUse(pi: ExtensionAPI): void {
  const images = new CuaImageSettings();
  registerVisionDebug(pi, images);
  const highlights = new WindowHighlights();
  const getMode = registerComputerMode(pi, () => highlights.clear());
  let session: ComputerSession | undefined;
  let loading: Promise<ComputerSession> | undefined;
  async function getSession(cwd: string): Promise<ComputerSession> {
    if (session) return session;
    if (!loading) loading = loadComputerConfig(cwd).then(config => {
      session = new ComputerSession(new McpDriver(config), getMode, () => images.settings(), highlights.flash);
      return session;
    });
    try { return await loading; }
    finally { loading = undefined; }
  }
  registerComputerTools(pi, getSession, async () => {
    const result: ComputerResult = session ? await session.close() : {
      content: [{ type: "text", text: "No owned computer-use runtime is running." }],
      details: { status: "closed", mode: getMode() },
    };
    try { await highlights.close(); }
    catch { return { content: [{ type: "text", text: "Qt frame shutdown is unconfirmed." }],
      details: { status: "unknown", mode: getMode() }, isError: true }; }
    return result;
  });
  pi.on("session_shutdown", async () => {
    if (loading) await loading.catch(() => undefined);
    try { await session?.close(); } finally { await highlights.close(); }
    session = undefined;
  });
}
