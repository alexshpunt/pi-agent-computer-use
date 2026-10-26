import { guideOptions, type GuideOptions } from "./image-guides.ts";
/** Native CUA window-capture settings. No pixels are transformed by this store. */
export interface CuaVisionSettings {
  kernel: "lanczos3" | "bilinear"; maxLongEdge: number; scale: number; version: number; route: "cua_native"; hints?: boolean; guides?: GuideOptions;
}
/** Default overview long edge (HD): large enough to read UI text, small enough for model image budgets. */
export const DEFAULT_MAX_LONG_EDGE = 1280;
/** The largest long edge CUA captures for this extension: windows up to it come at their own full resolution. */
export const FULL_RESOLUTION = 4096;
const defaults = (): CuaVisionSettings => ({ kernel: "lanczos3", maxLongEdge: DEFAULT_MAX_LONG_EDGE, scale: 1, version: 0, route: "cua_native" });

/** Validate and freeze the native cap; returned raster sizes are never adjusted by the extension. */
export function nativeImageCap(settings: Pick<CuaVisionSettings, "maxLongEdge" | "scale">): number {
  if (!Number.isSafeInteger(settings.maxLongEdge) || settings.maxLongEdge < 64 || settings.maxLongEdge > 4096 ||
    !Number.isFinite(settings.scale) || settings.scale < 0.05 || settings.scale > 1)
    throw new Error("Use a long edge 64..4096 and scale 0.05..1.");
  return Math.max(1, Math.floor(settings.maxLongEdge * settings.scale));
}

/** Session-local controls for the native cap. CUA owns resizing and fresh zoom. */
export class CuaImageSettings {
  private current = defaults();
  /** The trusted runtime owns the filter; the viewer may only change the cap. */
  constructor(private readonly overviewKernel: () => CuaVisionSettings["kernel"] = () => "lanczos3") {}
  /** In-flight captures keep their own immutable settings copy. */
  settings(): CuaVisionSettings { return structuredClone({ ...this.current, kernel: this.overviewKernel() }); }
  /** Unsupported kernels or extra fields fail without changing the active tuple. */
  update(value: unknown): CuaVisionSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected native CUA image settings.");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "kernel,maxLongEdge,scale" || input.kernel !== this.overviewKernel() ||
      !Number.isSafeInteger(input.maxLongEdge) || (input.maxLongEdge as number) < 64 || (input.maxLongEdge as number) > 4096 ||
      typeof input.scale !== "number" || !Number.isFinite(input.scale) || input.scale < 0.05 || input.scale > 1)
      throw new Error(`The selected native overview filter is ${this.overviewKernel()}; use long edge 64..4096 and scale 0.05..1. Saved crops and filter switches are unavailable.`);
    this.current = { ...this.current, maxLongEdge: input.maxLongEdge as number, scale: input.scale, version: this.current.version + 1 };
    return this.settings();
  }
  /** Toggle model-facing hints for future captures only; native sizing stays unchanged. */
  setHints(enabled: boolean): CuaVisionSettings {
    if (typeof enabled !== "boolean") throw Error("hints must be boolean.");
    this.current = { ...this.current, hints: enabled, version: this.current.version + 1 };
    return this.settings();
  }
  /** Validate the complete guide tuple and apply only to later annotations. */
  setGuides(value: unknown): CuaVisionSettings {
    const guides = guideOptions(value);
    this.current = { ...this.current, guides, version: this.current.version + 1 };
    return this.settings();
  }
  /** Restore the native defaults on a new session/reload. */
  reset(): void { this.current = defaults(); }
}
