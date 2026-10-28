import type { WindowTarget } from "./session.ts";
import { shellDesktop } from "./shell-desktop.ts";

/** A single native management command; desktop-frame coordinates never grant pointer authority. */
export type WindowManagementCommand = { action: "move"; x: number; y: number; unit: "windows_desktop_pixels" }
  | { action: "resize"; width: number; height: number; unit: "windows_desktop_pixels" }
  | { action: "minimize" | "maximize" | "focus" };
/** The most a confirmed resize may differ from the request in width or height. Matches the driver's receipt contract. */
export const MAX_RESIZE_SIZE_DIFFERENCE_PX = 2;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const nonblank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Validate one JSON command before consuming its state reference. */
export function parseWindowManagement(value: Record<string, unknown>): WindowManagementCommand {
  const action = value.action;
  const fields = action === "move" ? ["action", "x", "y", "unit"] : action === "resize" ? ["action", "width", "height", "unit"] : ["action"];
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error("Window management accepts only fields belonging to one operation.");
  if (action === "move" && value.unit === "windows_desktop_pixels" && integer(value.x, -100000, 100000) && integer(value.y, -100000, 100000))
    return { action, x: value.x, y: value.y, unit: value.unit };
  if (action === "resize" && value.unit === "windows_desktop_pixels" && integer(value.width, 1, 32767) && integer(value.height, 1, 32767))
    return { action, width: value.width, height: value.height, unit: value.unit };
  if (action === "minimize" || action === "maximize" || action === "focus") return { action };
  throw new Error("Use move with integer x/y or resize with width/height and unit windows_desktop_pixels, or one minimize/maximize/focus action.");
}
function bounds(value: unknown): value is Record<"x" | "y" | "width" | "height", number> {
  return object(value) && integer(value.x, -2147483648, 2147483647) && integer(value.y, -2147483648, 2147483647) &&
    integer(value.width, 1, 32767) && integer(value.height, 1, 32767) &&
    integer(value.x + value.width, -2147483648, 2147483647) && integer(value.y + value.height, -2147483648, 2147483647);
}
function sample(value: unknown, target: WindowTarget): value is Record<string, unknown> {
  return object(value) && bounds(value.bounds) && (value.bounds_source === "dwm_visible_frame" || value.bounds_source === "window_rect") &&
    value.coordinate_space === "windows_desktop_pixels" && ["minimized", "maximized", "visible", "foreground_at_target"].every(key => typeof value[key] === "boolean") &&
    (value.keyboard_focus_at_target === null || typeof value.keyboard_focus_at_target === "boolean") &&
    integer(value.foreground_window, 0, Number.MAX_SAFE_INTEGER) && value.foreground_at_target === (value.foreground_window === target.window_id) &&
    shellDesktop(value.virtual_desktop).status === "sampled";
}
/** Admit exact-source native metadata without capture or application-input authority. */
export function validWindowControlState(state: Record<string, unknown>, target: WindowTarget): boolean {
  return state.pid === target.pid && state.window_id === target.window_id && nonblank(state.state_id) && sample(state.state, target);
}
/** Judge a source-bound native receipt; incomplete dispatch never grants permission to replay. */
export function windowManagementStatus(state: Record<string, unknown> | undefined, target: WindowTarget, nativeId: string,
  command: WindowManagementCommand, isError: boolean): "delivered" | "refused" | "unknown" {
  if (!state || state.pid !== target.pid || state.window_id !== target.window_id || state.state_id !== nativeId ||
    state.operation !== command.action || state.route !== "native" ||
    !(state.before === null || sample(state.before, target)) || !(state.observed === null || sample(state.observed, target)) ||
    !(state.requested_bounds === null || bounds(state.requested_bounds))) return "unknown";
  if (isError) return state.status === "refused" && state.effect === "refused" && nonblank(state.code) &&
    state.mutation_attempted === false && state.mutation_accepted === false && state.postcondition_confirmed === false ? "refused" : "unknown";
  if (state.effect !== "confirmed" || state.mutation_attempted !== true || state.mutation_accepted !== true || state.postcondition_confirmed !== true ||
    !sample(state.before, target) || !sample(state.observed, target)) return "unknown";
  const before = state.before, observed = state.observed;
  if (command.action === "move" || command.action === "resize") {
    if (before.minimized || before.maximized || observed.minimized || observed.maximized || before.bounds_source !== observed.bounds_source ||
      !bounds(before.bounds) || !bounds(observed.bounds) || !bounds(state.requested_bounds)) return "unknown";
    const requested = command.action === "move" ? { ...before.bounds, x: command.x, y: command.y }
      : { ...before.bounds, width: command.width, height: command.height };
    const requestedBounds = state.requested_bounds, observedBounds = observed.bounds;
    // Windows scales a DPI-unaware window in whole logical pixels, so a resize may land a pixel away; position stays exact.
    const reached = (key: "x" | "y" | "width" | "height") => observedBounds[key] === requested[key] ||
      command.action === "resize" && (key === "width" || key === "height") && Math.abs(observedBounds[key] - requested[key]) <= MAX_RESIZE_SIZE_DIFFERENCE_PX;
    return (["x", "y", "width", "height"] as const).every(key => requestedBounds[key] === requested[key] && reached(key)) ? "delivered" : "unknown";
  }
  if (state.requested_bounds !== null) return "unknown";
  if (command.action === "minimize") return !before.minimized && observed.minimized === true ? "delivered" : "unknown";
  const desktop = shellDesktop(before.virtual_desktop);
  if (before.minimized || desktop.status !== "sampled" || desktop.on_current_desktop !== true) return "unknown";
  if (command.action === "maximize") return !before.maximized && observed.maximized === true && observed.minimized === false ? "delivered" : "unknown";
  return observed.foreground_at_target === true && observed.minimized === false ? "delivered" : "unknown";
}
