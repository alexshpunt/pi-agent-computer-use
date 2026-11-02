import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Input, SettingsList, truncateToWidth, type SettingItem, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { CuaImageSettings } from "./cua-image-settings.ts";
import { VisualSettings, type VisualOptions } from "./native-visuals.ts";
import type { ComputerMode } from "./session.ts";
import type { HumanStop } from "./human-stop.ts";
import type { PreferencesController } from "./preferences-controller.ts";

async function readConfig(cwd: string): Promise<Record<string, unknown>> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path.join(cwd, ".pi", "computer-use.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read .pi/computer-use.json; settings were not changed.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid .pi/computer-use.json; settings were not changed.");
  return raw as Record<string, unknown>;
}

export async function readLegacyEscapeStop(cwd: string): Promise<boolean | undefined> {
  const value = (await readConfig(cwd)).escapeStop;
  if (value !== undefined && typeof value !== "boolean") throw new Error("Invalid escapeStop in .pi/computer-use.json.");
  return value as boolean | undefined;
}

export async function readEscapeStop(cwd: string): Promise<boolean> {
  return (await readLegacyEscapeStop(cwd)) !== false;
}

export async function writeEscapeStop(cwd: string, value: boolean | undefined): Promise<void> {
  const config = await readConfig(cwd);
  if (config.escapeStop !== undefined && typeof config.escapeStop !== "boolean") throw new Error("Invalid escapeStop in .pi/computer-use.json.");
  if (value === undefined && config.escapeStop === undefined) return;
  if (value === undefined) delete config.escapeStop; else config.escapeStop = value;
  const dir = path.join(cwd, ".pi");
  const file = path.join(dir, "computer-use.json");
  await mkdir(dir, { recursive: true });
  const mode = await stat(file).then(info => info.mode & 0o777).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return 0o600; throw error; });
  const temp = path.join(dir, `.computer-use-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode, flag: "wx" });
    await rename(temp, file);
  } finally { await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
}

type ModeControl = (() => ComputerMode) & { select: (value: string, ctx: ExtensionCommandContext) => Promise<void> };
type Options = { mode: ModeControl; images: CuaImageSettings; visuals: VisualSettings; stop: HumanStop; preferences?: PreferencesController };
const onOff = (value: boolean) => value ? "on" : "off";
const booleanValues = ["on", "off"];

/** One human-facing view over the same stores used by the existing commands. */
export function registerComputerSettingsCommand(pi: ExtensionAPI, options: Options): void {
  pi.registerCommand("computer-settings", {
    description: "Open Computer Use settings.",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("Computer settings require an interactive terminal.", "error"); return; }
      let escapeStop: boolean;
      let scoped: Awaited<ReturnType<PreferencesController["read"]>> | undefined;
      let scope: "project" | "global" = "project";
      if (options.preferences) {
        const choice = await ctx.ui.select("Computer Use settings", ctx.isProjectTrusted() ? ["Project", "Global"] : ["Global"]);
        if (!choice) return;
        scope = choice === "Project" ? "project" : "global";
      }
      try {
        scoped = await options.preferences?.read(ctx);
        escapeStop = scoped ? scoped.effective.escape ?? true : await readEscapeStop(ctx.cwd);
      }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        const image = options.images.settings();
        const visual = options.visuals.current();
        const defaultImage = new CuaImageSettings().settings();
        const defaultValues = { mode: "yolo", escape: true, cap: defaultImage.maxLongEdge, scale: defaultImage.scale,
          hints: true, grid: false, action: false, ...new VisualSettings().current() };
        const numeric = (label: string): SettingItem["submenu"] => (current, finish) => {
          const input = new Input({ prompt: `${label} (or inherit): ` });
          input.setValue(current); input.handleInput("\u0005"); input.focused = true;
          input.onSubmit = value => finish(value.trim());
          input.onEscape = () => finish();
          return input;
        };
        const items: SettingItem[] = [
          { id: "mode", label: "Access mode", currentValue: options.mode(), values: ["yolo", "safe"], description: "yolo: access the desktop. safe: only session-opened windows. Safe is not an OS sandbox." },
          { id: "resume", label: "Computer use", currentValue: options.stop.stopped ? "stopped" : "on", values: ["on"], description: "on: allow input. stopped: the physical Escape shortcut stopped input. Select on to resume." },
          { id: "escape", label: "Triple Escape stop", currentValue: onOff(escapeStop), values: booleanValues, description: "on: three physical Escape presses stop input. off: disables this emergency stop. Restart Pi and reconnect machines after changing this setting." },
          { id: "cap", label: "Screenshot long edge", currentValue: String(image.maxLongEdge), submenu: numeric("Long edge (64–4096)"), description: "64–4096 pixels: maximum long edge before scale is applied. Affects future captures." },
          { id: "scale", label: "Screenshot scale", currentValue: String(image.scale), submenu: numeric("Scale (0.05–1)"), description: "0.05–1: multiplies the long-edge limit. 1 keeps the full limit; 0.5 halves it." },
          { id: "hints", label: "Screenshot hints", currentValue: onOff(image.hints !== false), values: booleanValues, description: "on: add element labels to screenshots. off: omit them." },
          { id: "grid", label: "Grid guide", currentValue: onOff(!!image.guides?.grid), values: booleanValues, description: "on: add a coordinate grid to screenshots. off: omit it." },
          { id: "action", label: "Action guide", currentValue: onOff(!!image.guides?.action), values: booleanValues, description: "on: mark the action location on screenshots. off: omit the marker." },
          { id: "preset", label: "Visual preset", currentValue: visual.preset, values: ["off", "subtle", "full"], description: "off: disable visuals. subtle: activity cues without previews by default. full: activity cues with previews by default." },
          ...([ ["observations", "Observation frames", "on: show frames for observations. off: hide them."], ["previews", "Image previews", "on: show operation image previews. off: hide them."], ["pointer", "Pointer actions", "on: show pointer action details. off: hide them."], ["scroll_drag", "Scroll and drag", "on: show scroll and drag details. off: hide them."], ["keyboard", "Keyboard actions", "on: show keyboard action details. off: hide them."], ["typed_text", "Show typed text", "on: show typed text when keyboard details are enabled. off: hide it. Password fields stay private."], ["reduced_motion", "Reduced motion", "on: reduce visual animation. off: use normal animation."] ] as const).map(([id, label, description]) => ({ id, label, currentValue: onOff(visual[id]), values: booleanValues, description })),
          { id: "quality", label: "Visual quality", currentValue: visual.quality, values: ["performance", "balanced", "high"], description: "performance: favor speed. balanced: balance speed and quality. high: favor visual quality." },
          { id: "opacity", label: "Visual opacity", currentValue: String(visual.opacity), submenu: numeric("Opacity (0–1)"), description: "0–1: visual opacity. 0 is transparent; 1 is fully opaque." },
          { id: "reset-images", label: "Reset screenshot settings", currentValue: "reset", values: ["reset"], description: "reset: clear screenshot overrides in the selected scope." },
        ];
        if (scoped) for (const item of items) {
          if (item.id === "resume" || item.id === "reset-images") continue;
          if (item.values) item.values = [...item.values, "inherit"];
        }
        const descriptions = new Map(items.map(item => [item.id, item.description ?? ""]));
        let busy = false;
        const sync = () => {
          const current = options.images.settings(); const v = options.visuals.current();
          list.updateValue("mode", options.mode()); list.updateValue("resume", options.stop.stopped ? "stopped" : "on");
          list.updateValue("escape", onOff(escapeStop)); list.updateValue("cap", String(current.maxLongEdge)); list.updateValue("scale", String(current.scale));
          list.updateValue("hints", onOff(current.hints !== false)); list.updateValue("grid", onOff(!!current.guides?.grid)); list.updateValue("action", onOff(!!current.guides?.action));
          for (const key of ["preset", "quality", "opacity"] as const) list.updateValue(key, String(v[key]));
          for (const key of ["observations", "previews", "pointer", "scroll_drag", "keyboard", "typed_text", "reduced_motion"] as const) list.updateValue(key, onOff(v[key]));
          if (scoped) for (const item of items) {
            if (["resume", "reset-images"].includes(item.id)) continue;
            const key = item.id as keyof typeof scoped.sources;
            const source = item.id === "mode" && scoped.effective.mode !== undefined && scoped.effective.mode !== options.mode() ? "session" : scoped.sources[key] ?? "default or session";
            item.description = `${descriptions.get(item.id)} Effective: ${item.currentValue} (${source}). Select inherit to clear the ${scope} override.`;
            const stored = scoped[scope][key];
            const fallback = scope === "global" ? defaultValues[key] : undefined;
            const value = stored ?? (scope === "global" && key === "previews" && scoped.global.preset === "subtle" ? false : fallback);
            if (value !== undefined) list.updateValue(item.id, typeof value === "boolean" ? onOff(value) : String(value));
          }
        };
        let unsubscribe = () => {};
        const settingsTheme = getSettingsListTheme();
        const listTheme = { ...settingsTheme, hint: (text: string) => settingsTheme.hint(text.replace("Esc to cancel", "Esc to close")) };
        const visibleRows = Math.max(3, Math.min(12, tui.terminal.rows - 15));
        const list = new SettingsList(items, visibleRows, listTheme, (id, value) => {
          busy = true;
          void (async () => {
            if (options.preferences && id !== "resume") {
              if (id === "reset-images") {
                for (const key of ["cap", "scale", "hints", "grid", "action"]) scoped = await options.preferences.set(ctx, scope, key, undefined);
              } else {
                let parsed: unknown = value === "inherit" ? undefined : value;
                if (parsed !== undefined && ["cap", "scale", "opacity"].includes(id)) {
                  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error("Enter a number or inherit.");
                  parsed = Number(value);
                } else if (parsed !== undefined && !["mode", "preset", "quality"].includes(id)) parsed = value === "on";
                scoped = await options.preferences.set(ctx, scope, id, parsed);
                if (id === "mode" && value !== "inherit" && scoped.effective.mode === value && options.mode() === value)
                  await options.mode.select(value, ctx);
              }
              escapeStop = scoped!.effective.escape ?? true;
            }
            else if (id === "mode" || id === "resume") await options.mode.select(id === "resume" ? options.mode() : value, ctx);
            else if (id === "escape") { await writeEscapeStop(ctx.cwd, value === "on"); escapeStop = value === "on"; }
            else if (id === "cap" || id === "scale") {
              const current = options.images.settings();
              if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error("Enter a number.");
              options.images.update({ kernel: current.kernel, maxLongEdge: id === "cap" ? Number(value) : current.maxLongEdge, scale: id === "scale" ? Number(value) : current.scale });
            } else if (id === "reset-images") options.images.reset();
            else if (id === "hints") options.images.setHints(value === "on");
            else if (id === "grid" || id === "action") {
              const guides = options.images.settings().guides;
              options.images.setGuides({ grid: id === "grid" ? value === "on" : !!guides?.grid, action: id === "action" ? value === "on" : !!guides?.action });
            } else {
              const patch = { [id]: id === "opacity" ? Number(value) : id === "preset" || id === "quality" ? value : value === "on" } as Partial<VisualOptions>;
              if (id === "opacity" && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error("Enter a number.");
              pi.appendEntry("computer-use-visuals", options.visuals.update(patch));
            }
          })().catch(error => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
            .finally(() => { busy = false; sync(); tui.requestRender(); });
        }, () => { unsubscribe(); done(); });
        sync();
        const refresh = () => { sync(); tui.requestRender(); };
        const offStop = options.stop.onStop(refresh);
        const offResume = options.stop.onResume(refresh);
        unsubscribe = () => { offStop(); offResume(); };
        return {
          dispose() { unsubscribe(); },
          render(width: number) { return [truncateToWidth(theme.fg("accent", theme.bold(options.preferences ? `Computer Use settings · ${scope === "project" ? "Project" : "Global"}` : "Computer Use settings")), width), "", ...list.render(width)]; },
          invalidate() { list.invalidate(); },
          handleInput(data: string) { if (!busy) list.handleInput(data); tui.requestRender(); },
          handleMouse(event: TuiMouseEvent) { if (busy || event.y < 2) return undefined; return list.handleMouse({ ...event, y: event.y - 2 }); },
        };
      });
    },
  });
}
