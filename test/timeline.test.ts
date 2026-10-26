import { expect, test } from "vitest";
import { nativeInput, requestedInputTime, validateInput, type InputCommand } from "../src/complete-input.ts";

const observed = { tokens: new Set<string>(), width: 800, height: 600 };
const timeline = (events: unknown[]) => ({ action: "timeline", events }) as InputCommand;

test("a timeline maps to input_timeline with overview-pixel points and reports its length", () => {
  const command = timeline([
    { at_ms: 0, type: "key_down", key: "shift" },
    { at_ms: 0, type: "button_down", button: "middle" },
    { at_ms: 20, type: "move", x: 400, y: 300 },
    { at_ms: 40, type: "move_relative", dx: -15, dy: 4 },
    { at_ms: 60, type: "wheel", dy: 2 },
    { at_ms: 80, type: "button_up", button: "middle" },
    { at_ms: 80, type: "key_up", key: "shift" },
    { at_ms: 100, type: "pen_down", x: 10, y: 10, pressure: 0.2, tilt_x: 30 },
    { at_ms: 120, type: "pen_move", x: 20, y: 12, pressure: 0.9 },
    { at_ms: 140, type: "pen_up", x: 20, y: 12 },
  ]);
  validateInput(command, observed);
  expect(nativeInput(command, { pid: 3, window_id: 4 }, "foreground")).toEqual({ name: "input_timeline",
    args: { pid: 3, window_id: 4, events: command.events, delivery_mode: "foreground" } });
  expect(requestedInputTime(command)).toBe(140);
});

test.each([
  [[{ at_ms: 0, type: "key_up", key: "w" }], /not down/],
  [[{ at_ms: 0, type: "button_down" }, { at_ms: 1, type: "button_down", button: "left" }], /already down/],
  [[{ at_ms: 10, type: "key_down", key: "w" }, { at_ms: 5, type: "key_up", key: "w" }], /non-decreasing/],
  [[{ at_ms: 0, type: "move", x: 800, y: 10 }], /inside the current/],
  [[{ at_ms: 0, type: "pen_down", x: 1, y: 1, pressure: 1.5 }], /pressure/],
  [[{ at_ms: 0, type: "wheel" }], /at least one nonzero/],
  [[{ at_ms: 0, type: "move", x: 1, y: 1, pressure: 0.5 }], /unsupported fields/],
  [[{ at_ms: 120001, type: "key_down", key: "w" }], /up to 120000/],
])("invalid timelines refuse before any input: %j", (events, message) => {
  expect(() => validateInput(timeline(events), observed)).toThrow(message);
});

// LPT-942: uia_only reaches the driver only on an element click or scroll.
test("uia_only is passed to an element click or scroll and refused elsewhere", () => {
  const target = { pid: 4, window_id: 9 };
  expect(nativeInput({ action: "click", element_token: "s1:0" }, target, "background", undefined, false, true).args).toMatchObject({ element_token: "s1:0", uia_only: true });
  expect(nativeInput({ action: "scroll", element_token: "s1:0", direction: "down", amount: 2 } as never, target, "background", undefined, false, true).args).toMatchObject({ uia_only: true });
  expect(nativeInput({ action: "click", element_token: "s1:0" }, target, "background").args).not.toHaveProperty("uia_only");
  expect(() => nativeInput({ action: "click", x: 3, y: 4 }, target, "background", "cap", false, true)).toThrow("uia_only takes a click or scroll on an element token.");
  expect(() => nativeInput({ action: "key", key: "a" }, target, "background", undefined, false, true)).toThrow("uia_only");
});
