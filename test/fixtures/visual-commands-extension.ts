import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CuaImageSettings } from "../../src/cua-image-settings.ts";
import { registerImageSettingsCommand } from "../../src/image-settings-command.ts";
import { VisualSettings } from "../../src/native-visuals.ts";
import { registerVisualSettingsCommand } from "../../src/visual-settings-command.ts";

/** Real Pi owns command dispatch, session entries and tree navigation; this fixture only reads the outcome. */
export default function(pi: ExtensionAPI): void {
  const visuals = new VisualSettings(); const images = new CuaImageSettings();
  registerVisualSettingsCommand(pi, visuals); registerImageSettingsCommand(pi, images);
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
