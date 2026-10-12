import type { InputCommand } from "./complete-input.ts";

/** Identify the coordinate form; validation and capture admission still run before dispatch. */
export function isCoordinateScroll(command: InputCommand): boolean {
  return command.action === "scroll" && (command.x !== undefined || command.y !== undefined);
}

/** Check native input completion, not content displacement. A partial or mismatched prefix is unknown. */
export function scrollReceipt(command: InputCommand, state: Record<string, unknown>): boolean {
  const dx = command.delta_x ?? 0, dy = command.delta_y ?? 0;
  const axes = [...(dy ? ["y"] : []), ...(dx ? ["x"] : [])];
  const complete = (value: unknown) => Array.isArray(value) && value.length === axes.length && value.every((axis, index) => axis === axes[index]);
  return state.attempted === true && state.delivered === true && state.pointer_attempted === true && state.pointer_delivered === true &&
    state.delta_x === dx && state.delta_y === dy && state.unit === "wheel_detents" && state.unit === command.unit &&
    complete(state.attempted_axes) && complete(state.delivered_axes) && state.route === "native" &&
    state.effect === "unverifiable" && state.delivery_mode === "foreground" &&
    ["foreground_changed", "pointer_changed", "foreground_at_target", "pointer_at_target"]
      .every(key => state[key] === null || typeof state[key] === "boolean");
}
