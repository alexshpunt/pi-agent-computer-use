import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CuaImageSettings } from "./cua-image-settings.ts";

const usage = "Usage: /computer-images [show | cap 64..4096 | scale 0.05..1 | hints on|off | guides off|grid|action|all | reset].";

/** Human-only controls for future captures; no viewer, listener, native process or image retention. */
export function registerImageSettingsCommand(pi: ExtensionAPI, images: CuaImageSettings): void {
  pi.registerCommand("computer-images", {
    description: "Show or change session-local screenshot sizing, hint labels and image guides for future captures.",
    getArgumentCompletions: prefix => ["show", "cap", "scale", "hints on", "hints off", "guides off", "guides grid", "guides action", "guides all", "reset"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const [command = "show", value] = parts;
      try {
        const current = images.settings();
        if (command === "show" || command === "reset") {
          if (parts.length > 1) throw Error(usage);
          if (command === "reset") images.reset();
        } else if (command === "cap" || command === "scale") {
          if (parts.length !== 2 || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw Error(usage);
          images.update({ kernel: current.kernel, maxLongEdge: command === "cap" ? Number(value) : current.maxLongEdge,
            scale: command === "scale" ? Number(value) : current.scale });
        } else if (command === "hints") {
          if (parts.length !== 2 || (value !== "on" && value !== "off")) throw Error(usage);
          images.setHints(value === "on");
        } else if (command === "guides") {
          if (parts.length !== 2 || !["off", "grid", "action", "all"].includes(value)) throw Error(usage);
          images.setGuides({ grid: value === "grid" || value === "all", action: value === "action" || value === "all" });
        } else throw Error(usage);
        const settings = images.settings();
        ctx.ui.notify(`Computer images: ${settings.maxLongEdge} px maximum, scale ${settings.scale}, ${settings.kernel}; hints ${settings.hints === false ? "off" : "on"}, `
          + `grid ${settings.guides?.grid ? "on" : "off"}, action guide ${settings.guides?.action ? "on" : "off"}. Applies to future captures in this session.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : usage, "warning");
      }
    },
  });
}
