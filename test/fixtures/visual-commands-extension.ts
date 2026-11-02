import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CuaImageSettings } from "../../src/cua-image-settings.ts";
import { VisualSettings } from "../../src/native-visuals.ts";
import { registerVisualPreferences } from "../../src/visual-preferences.ts";

/** Real Pi owns session entries and tree navigation; fixture commands create and inspect preferences. */
export default function(pi: ExtensionAPI): void {
  const visuals = new VisualSettings(); const images = new CuaImageSettings();
  registerVisualPreferences(pi, visuals);
  pi.registerCommand("visual-set", {
    description: "Save test preferences.",
    handler: async text => {
      try { pi.appendEntry("computer-use-visuals", visuals.update(JSON.parse(text))); } catch { /* Invalid fixture input must not save. */ }
    },
  });
  pi.registerCommand("visual-probe", {
    description: "Save the current test preferences.",
    handler: async (_args, ctx) => {
      await writeFile(path.join(ctx.cwd, "preferences.json"), JSON.stringify({ visuals: visuals.current(), images: images.settings(),
        branch: ctx.sessionManager.getBranch() }));
    },
  });
  pi.registerCommand("visual-navigate", {
    description: "Navigate the test session without inference.",
    handler: async (target, ctx) => { await ctx.navigateTree(target.trim(), { summarize: false }); },
  });
}
