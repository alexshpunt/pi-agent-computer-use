/** Common capture provenance. Unknown native fields stay null; image and semantic scopes are distinct. */
export interface ObservationSource {
  kind: "display" | "window" | "browser";
  domain: "windows-host";
  identity: Record<string, string | number>;
  captured_at: string;
  timestamp_boundary: "native_call_completed";
  image: {
    scope: "primary_display" | "primary_display_region" | "native_window" | "native_window_zoom";
    coordinate_space: "display_image_pixels" | "window_image_pixels" | "zoom_image_pixels" | "detail_image_pixels";
    dimensions: { width: number | null; height: number | null };
    original_dimensions: { width: number; height: number } | null;
    origin: { x: number; y: number; relative_to: "primary_display" | "window" } | null;
    native_bounds: unknown;
    crop?: { requested: { x: number; y: number; width: number; height: number }; applied: { x: number; y: number; width: number; height: number }; coordinate_space: "uncropped_image_pixels" };
  };
  semantic_scope: "none" | "native_window" | "owned_page";
  scale: { native_scale_factor: number | null; screenshot_scale: number | null; dpi: null; device_pixel_ratio: null };
  capabilities: { read: true; input: "none" | "window_observation" | "owned_browser"; detail: "unsupported" | "browser_window_zoom" | "window_zoom" | "display_crop" };
  visibility: { minimized: boolean | null; occluded: null; paint_freshness: "unverified" };
}
const positive = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** Report native capture geometry without deriving DPI, page coordinates or missing original pixels. */
export function observationSource(kind: ObservationSource["kind"], native: Record<string, unknown>,
  identity: ObservationSource["identity"], zoom = false): ObservationSource {
  const originalWidth = positive(native.screenshot_original_width);
  const originalHeight = positive(native.screenshot_original_height);
  return {
    kind, domain: "windows-host", identity: { ...identity }, captured_at: new Date().toISOString(), timestamp_boundary: "native_call_completed",
    image: { scope: kind === "display" ? "primary_display" : zoom ? "native_window_zoom" : "native_window",
      coordinate_space: kind === "display" ? "display_image_pixels" : zoom ? "zoom_image_pixels" : "window_image_pixels",
      dimensions: { width: positive(zoom ? native.width : native.screenshot_width), height: positive(zoom ? native.height : native.screenshot_height) },
      original_dimensions: originalWidth && originalHeight ? { width: originalWidth, height: originalHeight } : null,
      origin: zoom ? null : { x: 0, y: 0, relative_to: kind === "display" ? "primary_display" : "window" },
      native_bounds: native.window_bounds ?? null },
    semantic_scope: kind === "display" ? "none" : kind === "window" ? "native_window" : "owned_page",
    scale: { native_scale_factor: positive(native.scale_factor), screenshot_scale: positive(native.screenshot_scale), dpi: null, device_pixel_ratio: null },
    capabilities: { read: true, input: kind === "display" ? "none" : kind === "window" ? "window_observation" : "owned_browser",
      detail: kind === "browser" ? "browser_window_zoom" : zoom ? "unsupported" : kind === "display" ? "display_crop" : "window_zoom" },
    visibility: { minimized: typeof native.minimized === "boolean" ? native.minimized : null, occluded: null, paint_freshness: "unverified" },
  };
}
