import type { ScreenRect } from "./highlight-geometry.ts";
import type { ObservationSource } from "./observation-source.ts";
import { observationSource, sourceIdentity } from "./observation-source.ts";

/** Native logical monitor identity, valid only with the returned topology token. Not a permanent serial. */
export interface NativeDisplay {
  display_id: string;
  monitor_handle: string;
  monitor_device_paths: string[];
  bounds: ScreenRect;
  work_area: ScreenRect;
  primary: boolean;
  scale_factor: number | null;
  dpi: number | null;
}
const rectangle = (value: unknown): value is ScreenRect => {
  const r = value as ScreenRect | undefined;
  return !!r && [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) && r.width > 0 && r.height > 0;
};
/** Validate the public native metadata shape. CUA owns topology and native lifetime checks. */
export function nativeDisplay(value: unknown): NativeDisplay {
  const d = value as NativeDisplay | undefined;
  if (!d || typeof d.display_id !== "string" || !d.display_id || typeof d.monitor_handle !== "string" || !d.monitor_handle ||
    !Array.isArray(d.monitor_device_paths) || !d.monitor_device_paths.every(p => typeof p === "string") ||
    !rectangle(d.bounds) || !rectangle(d.work_area) || typeof d.primary !== "boolean" ||
    !(d.scale_factor === null || typeof d.scale_factor === "number" && Number.isFinite(d.scale_factor) && d.scale_factor > 0) ||
    !(d.dpi === null || Number.isSafeInteger(d.dpi) && d.dpi > 0))
    throw new Error("CUA returned invalid native display metadata.");
  return d;
}
/** Add explicit monitor membership only for an exact native display read, never for nearby windows. */
export function selectedDisplaySource(state: Record<string, unknown>, sessionId: string, ref: string): ObservationSource {
  const display = nativeDisplay(state.display);
  const source = observationSource("display", state, { session_id: sessionId, display_ref: ref, display_id: display.display_id, topology_id: state.topology_id as string });
  Object.assign(source, sourceIdentity(source.identity, display.display_id));
  source.image.scope = "selected_display";
  source.image.origin = { x: 0, y: 0, relative_to: "display" };
  source.image.native_bounds = display.bounds;
  source.scale.native_scale_factor = display.scale_factor;
  // The current native contract reports unknown DPI. No value is derived from scale.
  return source;
}
