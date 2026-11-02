import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CuaImageSettings } from "./cua-image-settings.ts";
import type { VisualOptions, VisualSettings } from "./native-visuals.ts";
import type { ComputerMode } from "./session.ts";
import { readLegacyEscapeStop, writeEscapeStop } from "./computer-settings.ts";
import { readScopedPreferences, writeScopedPreference, type PreferenceKey, type ScopedValues } from "./scoped-preferences.ts";

type ModeControl = (() => ComputerMode) & {
  select(value: string, ctx: ExtensionCommandContext): Promise<void>;
  applyPreference(value: ComputerMode, ctx: ExtensionContext): Promise<boolean>;
  allowsPreference(value: ComputerMode): boolean;
  recordPreference(): void;
};
type Scope = "global" | "project";

/** Applies user-controlled values without resuming a human stop. */
export class PreferencesController {
  private visualBaseline: VisualOptions;
  private modeBaseline: ComputerMode;
  private modeFromSession = false;
  private legacyPreview = false;
  constructor(private readonly images: CuaImageSettings, private readonly visuals: VisualSettings, private readonly mode: ModeControl) {
    this.visualBaseline = visuals.current();
    this.modeBaseline = mode();
  }
  async read(ctx: ExtensionContext) {
    const snapshot = await readScopedPreferences(ctx.cwd, ctx.isProjectTrusted());
    // The old project file remains authoritative until the user edits this preference.
    if (ctx.isProjectTrusted() && snapshot.project.escape === undefined) {
      const legacy = await readLegacyEscapeStop(ctx.cwd);
      if (legacy !== undefined) {
        snapshot.project.escape = legacy;
        snapshot.effective.escape = legacy;
        snapshot.sources.escape = "project";
      }
    }
    return snapshot;
  }
  captureBaseline(ctx: ExtensionContext) {
    this.visualBaseline = this.visuals.current(); this.modeBaseline = this.mode();
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    this.modeFromSession = branch.some(entry => entry.type === "custom" && entry.customType === "computer-use-mode" && ((entry.data as { mode?: unknown } | undefined)?.mode === "safe" || (entry.data as { mode?: unknown } | undefined)?.mode === "yolo"));
    const visual = branch.filter(entry => entry.type === "custom" && entry.customType === "computer-use-visuals").at(-1);
    this.legacyPreview = visual?.type === "custom" && typeof (visual.data as { previews?: unknown } | undefined)?.previews === "boolean";
  }
  async apply(ctx: ExtensionContext, applyMode = true, preferSession = false) {
    const snapshot = await this.read(ctx);
    const v = snapshot.effective;
    if (applyMode) await this.mode.applyPreference(preferSession && this.modeFromSession ? this.modeBaseline : v.mode ?? this.modeBaseline, ctx);
    const image = this.images.settings();
    this.images.update({ kernel: image.kernel, maxLongEdge: v.cap ?? 1280, scale: v.scale ?? 1 });
    this.images.setHints(v.hints ?? true);
    this.images.setGuides({ grid: v.grid ?? false, action: v.action ?? false });
    const patch: Partial<VisualOptions> = { ...this.visualBaseline };
    for (const key of ["preset", "observations", "previews", "pointer", "scroll_drag", "keyboard", "typed_text", "reduced_motion", "quality", "opacity"] as const) {
      if (v[key] !== undefined) Object.assign(patch, { [key]: v[key] });
    }
    if (!this.legacyPreview && v.previews === undefined && v.preset === "subtle") patch.previews = false;
    if (!this.legacyPreview && v.previews === undefined && v.preset === "full") patch.previews = true;
    this.visuals.restore(patch);
    return snapshot;
  }
  async set(ctx: ExtensionCommandContext, scope: Scope, id: string, value: unknown) {
    if (scope === "project" && !ctx.isProjectTrusted()) throw new Error("Trust this project before changing its settings.");
    if (id === "mode") {
      const snapshot = await this.read(ctx);
      const project = scope === "project" ? value : snapshot.project.mode;
      const global = scope === "global" ? value : snapshot.global.mode;
      const candidate = project ?? global ?? this.modeBaseline;
      if ((candidate === "safe" || candidate === "yolo") && !this.mode.allowsPreference(candidate))
        throw new Error("Close the YOLO agent browser before applying Safe mode.");
    }
    if (scope === "project" && id === "escape") await readLegacyEscapeStop(ctx.cwd);
    await writeScopedPreference(ctx.cwd, scope, id as PreferenceKey, value as ScopedValues[PreferenceKey] | undefined);
    if (scope === "project" && id === "escape") await writeEscapeStop(ctx.cwd, undefined);
    const result = await this.apply(ctx, id === "mode");
    if (id === "mode") this.mode.recordPreference();
    return result;
  }
}
