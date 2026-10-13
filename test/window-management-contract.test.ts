import { expect, test } from "vitest";
import { parseWindowManagement, validWindowControlState, windowManagementStatus, type WindowManagementCommand } from "../src/window-management.ts";

const target = { pid: 42, window_id: 91 }, nativeId = "one-use";
const desktop: Record<string, unknown> = { desktop_id: "12345678-1234-1234-1234-123456789abc", on_current_desktop: true,
  desktop_id_error: null, on_current_desktop_error: null, sampled_at_unix_ms: 1 };
const sample = () => ({ bounds: { x: 60, y: 60, width: 640, height: 800 }, bounds_source: "dwm_visible_frame",
  coordinate_space: "windows_desktop_pixels", minimized: false, maximized: false, visible: true,
  foreground_at_target: false, keyboard_focus_at_target: null, foreground_window: 92, virtual_desktop: { ...desktop } });
const admission = () => ({ ...target, state_id: nativeId, state: sample() });
function receipt(command: WindowManagementCommand) {
  const before = sample(), observed = sample();
  const requested_bounds = command.action === "move" ? { ...before.bounds, x: command.x, y: command.y }
    : command.action === "resize" ? { ...before.bounds, width: command.width, height: command.height } : null;
  if (requested_bounds) observed.bounds = requested_bounds;
  if (command.action === "minimize") observed.minimized = true;
  if (command.action === "maximize") observed.maximized = true;
  if (command.action === "focus") { observed.foreground_at_target = true; observed.foreground_window = target.window_id; }
  return { ...target, state_id: nativeId, operation: command.action, requested_bounds, before, observed,
    mutation_attempted: true, mutation_accepted: true, postcondition_confirmed: true, route: "native", effect: "confirmed" };
}
const move = { action: "move", x: -100, y: 200, unit: "windows_desktop_pixels" } as const;

test("management parsing preserves integer desktop geometry and accepts only one operation", () => {
  for (const command of [move, { action: "resize", width: 1, height: 32767, unit: "windows_desktop_pixels" },
    { action: "minimize" }, { action: "maximize" }, { action: "focus" }])
    expect(parseWindowManagement(command)).toEqual(command);
  for (const command of [
    { ...move, x: 1.5 }, { ...move, y: -100001 }, { ...move, x: Number.NaN }, { ...move, x: null },
    { ...move, unit: "window_image_pixels" }, { ...move, width: 50 }, { ...move, pid: 42 },
    { ...move, delivery_mode: "foreground" }, { ...move, hint: "h1" }, { ...move, animation: "reactive" },
    { action: "resize", width: 0, height: 100, unit: "windows_desktop_pixels" },
    { action: "resize", width: 100, height: 32768, unit: "windows_desktop_pixels" },
    { action: "focus", unit: "windows_desktop_pixels" }, { action: "focus", x: 1 },
    { action: "sequence", sequence: [] }, { action: "restore" }, { action: "move", x: 1, y: 2 },
  ]) expect(() => parseWindowManagement(command)).toThrow();
});
test("fresh control metadata keeps exact identity, frame source, desktop queries and unknown focus", () => {
  expect(validWindowControlState(admission(), target)).toBe(true);
  const independentlyMeasured = admission();
  independentlyMeasured.state.minimized = true; independentlyMeasured.state.maximized = true;
  expect(validWindowControlState(independentlyMeasured, target)).toBe(true);
  const unknown = admission();
  unknown.state.virtual_desktop = { ...desktop, on_current_desktop: null,
    on_current_desktop_error: { code: "current_desktop_query_failed", hresult: -1 } };
  expect(validWindowControlState(unknown, target)).toBe(true);
  for (const patch of [{ pid: 43 }, { state_id: "" }, { state: {} },
    { state: { ...sample(), bounds_source: "css" } }, { state: { ...sample(), foreground_at_target: true } },
    { state: { ...sample(), keyboard_focus_at_target: undefined } },
    { state: { ...sample(), bounds: { ...sample().bounds, width: 1.5 } } },
    { state: { ...sample(), virtual_desktop: { ...desktop, on_current_desktop_error: undefined } } }])
    expect(validWindowControlState({ ...admission(), ...patch }, target)).toBe(false);
});
test("success confirms exactly the requested geometry or native state, not fresh paint or keyboard focus", () => {
  for (const command of [move, { action: "resize", width: 600, height: 700, unit: "windows_desktop_pixels" },
    { action: "minimize" }, { action: "maximize" }, { action: "focus" }] as WindowManagementCommand[])
    expect(windowManagementStatus(receipt(command), target, nativeId, command, false)).toBe("delivered");
  const valid = receipt(move);
  for (const patch of [{ pid: 43 }, { window_id: 92 }, { state_id: "other" }, { operation: "resize" },
    { route: "assisted" }, { effect: "unknown" }, { mutation_accepted: false }, { postcondition_confirmed: false },
    { before: null }, { observed: null }, { requested_bounds: { ...valid.requested_bounds!, width: 900 } },
    { observed: { ...valid.observed, bounds: { ...valid.observed.bounds, x: 100 } } },
    { observed: { ...valid.observed, bounds_source: "window_rect" } }])
    expect(windowManagementStatus({ ...valid, ...patch }, target, nativeId, move, false)).toBe("unknown");
  const focus = { action: "focus" } as const, focused = receipt(focus);
  focused.before.virtual_desktop.on_current_desktop = false;
  expect(windowManagementStatus(focused, target, nativeId, focus, false)).toBe("unknown");
});
test("only exact all-false native refusals are known not-applied; interrupted or absent prefixes stay unknown", () => {
  const refused = { ...target, state_id: nativeId, operation: "move", requested_bounds: null, before: null, observed: null,
    mutation_attempted: false, mutation_accepted: false, postcondition_confirmed: false,
    route: "native", status: "refused", effect: "refused", code: "window_state_expired" };
  expect(windowManagementStatus(refused, target, nativeId, move, true)).toBe("refused");
  for (const state of [undefined, { ...refused, state_id: "other" }, { ...refused, mutation_attempted: true },
    { ...refused, code: undefined }, { ...refused, mutation_accepted: true }, receipt(move)])
    expect(windowManagementStatus(state, target, nativeId, move, true)).toBe("unknown");
});
