import type { InputCommand } from "./complete-input.ts";

/** These complete actions never press a button or key, or restore focus/pointer afterward. */
export function isPointerMove(action: string): action is "move" | "hover" {
  return action === "move" || action === "hover";
}

/** Validate native completion only. A delivered movement/dwell is not proof of an app hover effect. */
export function pointerReceipt(command: InputCommand, state: Record<string, unknown>): boolean {
  const dwell = command.action === "hover" ? command.dwell_ms : 0;
  return state.attempted === true && state.delivered === true && state.route === "native" &&
    state.effect === "unverifiable" && state.delivery_mode === "foreground" && state.dwell_ms === dwell &&
    Number.isSafeInteger(state.dwell_elapsed_ms) && (state.dwell_elapsed_ms as number) >= (dwell ?? 0) &&
    ["foreground_changed", "pointer_changed", "foreground_at_target", "pointer_at_target"]
      .every(key => state[key] === null || typeof state[key] === "boolean");
}
