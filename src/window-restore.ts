import type { WindowTarget } from "./session.ts";

const bool = (value: unknown): value is boolean => typeof value === "boolean";
const optionalBool = (value: unknown) => value === null || bool(value);
const sameTarget = (state: Record<string, unknown>, target: WindowTarget) => state.pid === target.pid && state.window_id === target.window_id;

/** Admit a native metadata-only state without borrowing capture or UI authority. */
export function validWindowStatus(state: Record<string, unknown>, target: WindowTarget): boolean {
  return sameTarget(state, target) && typeof state.state_id === "string" && !!state.state_id.trim() &&
    bool(state.minimized) && bool(state.visible) && bool(state.foreground_at_target) && optionalBool(state.keyboard_focus_at_target);
}

/** Judge this exact native restore receipt; partial or malformed dispatch is never safe to replay. */
export function windowRestoreStatus(state: Record<string, unknown> | undefined, target: WindowTarget, nativeId: string, isError: boolean): "delivered" | "refused" | "unknown" {
  if (!state || !sameTarget(state, target) || state.state_id !== nativeId || state.route !== "native") return "unknown";
  const prefix = [state.restore_attempted, state.restore_requested, state.restored, state.activation_attempted, state.activation_succeeded];
  if (!prefix.every(bool) || !optionalBool(state.visible) || !optionalBool(state.foreground_at_target) ||
    !optionalBool(state.keyboard_focus_at_target) || !optionalBool(state.foreground_changed)) return "unknown";
  if (!isError && prefix.every(value => value === true) && state.visible === true && state.foreground_at_target === true && state.effect === "confirmed")
    return "delivered";
  if (isError && prefix.every(value => value === false) && state.effect === "refused" && state.status === "refused" && typeof state.code === "string")
    return "refused";
  return "unknown";
}
