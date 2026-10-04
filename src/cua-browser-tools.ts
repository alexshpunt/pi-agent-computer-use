import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CuaBrowser, CuaBrowserResult } from "./cua-browser.ts";

/** Focused native browser tools. Pi Codemode remains the only executor. */
export function registerCuaBrowserTools(pi: ExtensionAPI, browser: CuaBrowser): void {
  const hint = Type.String({ minLength: 1, pattern: "^[a-z]+$" });
  const options = { additionalProperties: false };
  const point = Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }) }, options);
  const outputSchema = Type.Object({
    status: Type.Union(["observed", "acted", "listed", "closed", "refused", "unknown"].map(value => Type.Literal(value))),
    text: Type.String(), tab: Type.Optional(Type.Integer()),
    elements: Type.Optional(Type.Array(Type.Object({ hint: Type.String(), role: Type.String(), name: Type.String(), value: Type.Optional(Type.String()) }))),
    tabs: Type.Optional(Type.Array(Type.Object({ tab: Type.Integer(), title: Type.String(), url: Type.String(), focused: Type.Boolean(), active: Type.Boolean() }))),
    image: Type.Optional(Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]) })),
  }, { additionalProperties: true });
  let checkpoint = browser.allocatedHints;
  const restore = (ctx: { sessionManager: { getBranch(): readonly unknown[] } }) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      const saved = entry as { type?: string; customType?: string; data?: { offset?: number } };
      const offset = saved.data?.offset;
      if (saved.type === "custom" && saved.customType === "browser-hint-offset" && typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0)
        browser.restoreHints(offset);
    }
    checkpoint = browser.allocatedHints;
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  const expose = (result: CuaBrowserResult) => {
    if (browser.allocatedHints > checkpoint) {
      checkpoint = browser.allocatedHints;
      pi.appendEntry("browser-hint-offset", { offset: checkpoint });
    }
    // Rejecting stops an awaited Codemode sequence; earlier input is not undone.
    if (result.isError) throw new Error(`${result.details.status}: ${result.details.text}`);
    const image = result.content.find(block => block.type === "image");
    return { ...result, structuredContent: { ...result.details, ...(image ? { image } : {}) } };
  };
  pi.registerTool({
    name: "browser_open", label: "Browser open", outputSchema,
    description: "Open one new Driver-owned isolated visible Windows browser through CUA. Returns snapshot-scoped short hints, text and a native 500px browser-window PNG including chrome. Native agent cursor is enabled. Each returned overview or zoom automatically raises only this owned browser through CUA and may switch keyboard focus; this is not a paint-readiness guarantee. No personal profile, Playwright, global input or OS sandbox. Existing owned opening refuses; navigate or close it instead. Unknown input/launch must not be replayed.",
    parameters: Type.Object({ url: Type.String({ minLength: 1 }) }, options),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async execute(_id, params, signal) { return expose(await browser.call("open", params, signal)); },
  });
  pi.registerTool({
    name: "browser_focus", label: "Browser focus", outputSchema,
    description: "Focus the single active owned CUA tab and return its working surface. Later calls omit page/observation IDs. This does not activate a tab. The returned overview raises only the owned browser through CUA and may switch keyboard focus; it does not guarantee current paint. Multiple/inactive tabs refuse: CUA has no public tab activation tool. Every semantic observation retires earlier hints.",
    parameters: Type.Object({ tab: Type.Integer({ minimum: 1 }) }, options),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal) { return expose(await browser.call("focus", params, signal)); },
  });
  pi.registerTool({
    name: "browser_observe", label: "Browser observe", outputSchema,
    description: "Observe the focused owned CUA browser. Before every overview or zoom, CUA raises only the owned browser and may switch keyboard focus; this is not a paint-readiness guarantee. Default: a fresh semantic snapshot with new short hints plus native window PNG (Lanczos3, 500px long edge; Vision debug controls next cap). image_only:true captures without renewing semantic hints. zoom:{x,y,width,height} uses last overview-image pixels for a FRESH native padded JPEG, up to 500px wide. It is not saved-original/nested crop. No region capture or hint overlay. Codemode: image(view.image) forwards PNG or JPEG; text(view.text) forwards semantics.",
    parameters: Type.Object({ image_only: Type.Optional(Type.Boolean()), zoom: Type.Optional(Type.Object({
      x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }), width: Type.Number({ exclusiveMinimum: 0, maximum: 500 }), height: Type.Number({ exclusiveMinimum: 0 }),
    }, options)) }, options),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async execute(_id, params, signal) { return expose(await browser.call("observe", params, signal)); },
  });
  pi.registerTool({
    name: "browser_act", label: "Browser act", outputSchema,
    description: "One native CUA action on the focused owned browser: click short hint or {x,y} from the fresh returned window/zoom PNG/JPEG; fill hint with text; hover hint; scroll:{hint,delta_y}; navigate URL. Default returns a window PNG without renewing hints. Returned captures raise only the owned browser through CUA and may switch keyboard focus; capture-free input does not raise it. observe:false skips capture for sequential Codemode input; observe:true renews semantics and returns PNG. Four awaited hint clicks can use one snapshot, then observe once. Pixel coordinates are mapped by CUA once, never page CSS. Native cursor visualizes supported input. wait_ms 0..5000 is a pause, not readiness. Retired hints refuse; unknown means no blind retry. No arbitrary key programs, coordinate move or standalone new/activate/close-tab API.",
    parameters: Type.Object({
      click: Type.Optional(Type.Union([hint, point])), fill: Type.Optional(hint), text: Type.Optional(Type.String({ maxLength: 4000 })), hover: Type.Optional(hint),
      scroll: Type.Optional(Type.Object({ hint, delta_y: Type.Number({ minimum: -2000, maximum: 2000 }) }, options)),
      navigate: Type.Optional(Type.String({ minLength: 1 })), observe: Type.Optional(Type.Boolean()), wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000 })),
    }, options),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async execute(_id, params, signal) { return expose(await browser.call("act", params, signal)); },
  });
  pi.registerTool({
    name: "browser_tabs", label: "Browser tabs", outputSchema,
    description: "List only the native tabs of this session's Driver-owned browser. Does not activate tabs, renew semantic hints or change desktop focus. Window-image work requires exactly one active tab. CUA has no public standalone tab create/activate/close operation.",
    parameters: Type.Object({}, options), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, _params, signal) { return expose(await browser.call("tabs", {}, signal)); },
  });
  pi.registerTool({
    name: "browser_close", label: "Browser close", outputSchema,
    description: "End this exact native CUA session, close its isolated browser/profile and release the owned Driver and identity peer. Does not touch personal browsers or the desktop Driver. Unknown cleanup is not success.",
    parameters: Type.Object({}, options), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute() { return expose(await browser.call("close", {})); },
  });
  pi.on("session_shutdown", async () => { await browser.call("close", {}); });
}
