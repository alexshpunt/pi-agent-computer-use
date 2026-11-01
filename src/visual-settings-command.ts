import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VisualSettings, type VisualOptions } from "./native-visuals.ts";

/** Human-only controls; persistence contains preferences, never images or input text. */
export function registerVisualSettingsCommand(pi: ExtensionAPI, settings: VisualSettings): void {
  const restore = (ctx: ExtensionContext) => {
    let saved: Partial<VisualOptions> = { preset: "full" };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "computer-use-visuals") saved = entry.data as Partial<VisualOptions>;
    }
    try { settings.restore(saved); } catch { settings.restore({ preset: "off" }); }
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.registerCommand("computer-visuals", {
    description: "Show or change native computer visuals: off, subtle, full, or JSON presentation preferences. No input or capture changes.",
    getArgumentCompletions: prefix => ["off", "subtle", "full"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        const text = args.trim();
        if (text) {
          const patch = ["off", "subtle", "full"].includes(text) ? { preset: text as VisualOptions["preset"] } : JSON.parse(text);
          pi.appendEntry("computer-use-visuals", settings.update(patch));
        }
        const value = settings.current();
        ctx.ui.notify(`Computer visuals: ${value.preset}. Previews ${value.previews ? "on" : "off"}; typed text ${value.typed_text ? "on" : "off"}; ${value.quality} quality; opacity ${Math.round(value.opacity * 100)}%; reduced motion ${value.reduced_motion ? "on" : "off"}.`, "info");
      } catch {
        ctx.ui.notify('Use /computer-visuals off|subtle|full, or JSON such as {"previews":false,"reduced_motion":true}. Preferences were not changed.', "warning");
      }
    },
  });
}
