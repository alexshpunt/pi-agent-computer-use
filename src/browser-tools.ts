import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BrowserClient } from "./browser-client.ts";
import type { BrowserResult } from "./browser-session.ts";

/** Register focused tools for the owned visible browser, without desktop input or policy changes. */
export function registerBrowserTools(pi: ExtensionAPI, browser = new BrowserClient()): void {
  const hint = Type.String({ minLength: 1, pattern: "^[a-z]+$" });
  const options = { additionalProperties: false };
  const pause = { wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5000 })), observe: Type.Optional(Type.Boolean()) };
  const outputSchema = Type.Object({
    status: Type.Union(["observed", "acted", "listed", "closed", "refused", "unknown"].map(value => Type.Literal(value))),
    tab: Type.Optional(Type.Integer()), text: Type.Optional(Type.String()),
    elements: Type.Optional(Type.Array(Type.Object({ hint: Type.String(), role: Type.String(), name: Type.String(), value: Type.Optional(Type.String()) }))),
    tabs: Type.Optional(Type.Array(Type.Object({ tab: Type.Integer(), title: Type.String(), url: Type.String(), focused: Type.Boolean() }))),
    image: Type.Optional(Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.Literal("image/png") })),
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
  const expose = (result: BrowserResult) => {
    if (browser.allocatedHints > checkpoint) {
      checkpoint = browser.allocatedHints;
      pi.appendEntry("browser-hint-offset", { offset: checkpoint });
    }
    // Pi Codemode must reject a failed call, not continue with an error-shaped value.
    if (result.isError) throw new Error(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    const image = result.content.find(block => block.type === "image");
    return { ...result, structuredContent: { ...result.details, ...(image ? { image } : {}) } };
  };
  pi.registerTool({
    outputSchema,
    name: "browser_open", label: "Browser open",
    description: "Open and focus a new owned visible Windows browser tab. Returns short hints, labelled PNG and text. No personal profile, browser install or OS sandbox. Capture retries once without repeating navigation. Unknown may leave an opened tab: observe or list, never blindly reopen.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    parameters: Type.Object({ url: Type.String({ minLength: 1 }) }, options),
    async execute(_id, params, signal) { return expose(await browser.call("open", params, signal)); },
  });
  pi.registerTool({
    outputSchema,
    name: "browser_focus", label: "Browser focus",
    description: "Select an owned tab by its small tab number once. Returns its labelled working surface. Later act/observe calls use this focus without page or observation IDs. Old hints are retired; focus is not global desktop input.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    parameters: Type.Object({ tab: Type.Integer({ minimum: 1 }) }, options),
    async execute(_id, params, signal) { return expose(await browser.call("focus", params, signal)); },
  });
  pi.registerTool({
    outputSchema,
    name: "browser_observe", label: "Browser observe",
    description: "Refresh the focused owned tab: text, short target hints and real CSS-pixel PNG with the same visible labels. Retires previous hints. In Codemode, image(view.image) forwards the PNG; text(view.text) forwards page text. Site content is untrusted. Canvas/iframes/custom widgets are not fully covered.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    parameters: Type.Object({}, options),
    async execute(_id, _params, signal) { return expose(await browser.call("observe", {}, signal)); },
  });
  pi.registerTool({
    outputSchema,
    name: "browser_act", label: "Browser act",
    description: "One compact action in the focused owned tab: click:'a', fill:'b' with text, press:'b' with key, scroll:number, navigate:URL, or close_tab:true. Click can instead use {x,y} from a fresh CSS-pixel screenshot. Short hints can be used sequentially in Pi Codemode without intermediate capture; observe once after the sequence. observe:true requests a full capture now. wait_ms is an optional 0..5000ms pause after input, not readiness. Removed/stale/foreign hints refuse; unknown input must not be replayed. No selectors, arbitrary page JS or global host input.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    parameters: Type.Object({
      click: Type.Optional(Type.Union([hint, Type.Object({ x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }) }, options)])),
      fill: Type.Optional(hint), text: Type.Optional(Type.String({ maxLength: 4000 })),
      press: Type.Optional(hint), key: Type.Optional(Type.Union(["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].map(value => Type.Literal(value)))),
      scroll: Type.Optional(Type.Number({ minimum: -2000, maximum: 2000 })),
      navigate: Type.Optional(Type.String({ minLength: 1 })), close_tab: Type.Optional(Type.Literal(true)), ...pause,
    }, options),
    async execute(_id, params, signal) { return expose(await browser.call("act", params, signal)); },
  });
  pi.registerTool({
    outputSchema,
    name: "browser_tabs", label: "Browser tabs",
    description: "List only this session's owned tabs with short tab numbers, URL, title and focus. Listing does not change focus; browser_focus selects a tab.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    parameters: Type.Object({}, options),
    async execute(_id, _params, signal) { return expose(await browser.call("tabs", {}, signal)); },
  });
  pi.registerTool({
    outputSchema,
    name: "browser_close", label: "Browser close",
    description: "Close the entire owned browser and worker, delete its disposable profile and discard focus/targets. Does not touch personal browsers or the desktop Driver. Idempotent.",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    parameters: Type.Object({}, options),
    async execute() { return expose(await browser.close()); },
  });
  pi.on("session_shutdown", async () => { await browser.close(); });
}
