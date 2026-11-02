import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VisualSettings, type VisualOptions } from "./native-visuals.ts";

/** Restore human visual preferences from the current session branch. */
export function registerVisualPreferences(pi: ExtensionAPI, settings: VisualSettings): void {
  const restore = (ctx: ExtensionContext) => {
    let saved: Partial<VisualOptions> = { preset: "full" };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "computer-use-visuals") saved = entry.data as Partial<VisualOptions>;
    }
    try { settings.restore(saved); } catch { settings.restore({ preset: "off" }); }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
}
