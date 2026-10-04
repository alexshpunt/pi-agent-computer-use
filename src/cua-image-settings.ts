/** Native CUA window-capture settings. No pixels are transformed by this store. */
export interface CuaVisionSettings {
  kernel: "lanczos3"; maxLongEdge: number; scale: number; version: number; route: "cua_native";
}
const defaults = (): CuaVisionSettings => ({ kernel: "lanczos3", maxLongEdge: 500, scale: 1, version: 0, route: "cua_native" });

/** Session-local controls for the native cap. CUA owns resizing and fresh zoom. */
export class CuaImageSettings {
  private current = defaults();
  /** In-flight captures keep their own immutable settings copy. */
  settings(): CuaVisionSettings { return { ...this.current }; }
  /** Unsupported kernels or extra fields fail without changing the active tuple. */
  update(value: unknown): CuaVisionSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected native CUA image settings.");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "kernel,maxLongEdge,scale" || input.kernel !== "lanczos3" ||
      !Number.isSafeInteger(input.maxLongEdge) || (input.maxLongEdge as number) < 64 || (input.maxLongEdge as number) > 4096 ||
      typeof input.scale !== "number" || !Number.isFinite(input.scale) || input.scale < 0.05 || input.scale > 1)
      throw new Error("Native CUA supports Lanczos3, long edge 64..4096 and scale 0.05..1. Saved crops and other kernels are unavailable.");
    this.current = { ...defaults(), maxLongEdge: input.maxLongEdge as number, scale: input.scale, version: this.current.version + 1 };
    return this.settings();
  }
  /** Restore the native defaults on a new session/reload. */
  reset(): void { this.current = defaults(); }
}
