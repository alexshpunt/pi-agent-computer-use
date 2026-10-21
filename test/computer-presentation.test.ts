import { expect, test } from "vitest";
import { presentComputerResult } from "../src/provider.ts";
import type { ComputerResult } from "../src/session.ts";


test("control-state presentation separates desktop frame coordinates from pointer input and preserves canonical data", () => {
  const result: ComputerResult = { content: [], details: { status: "observed", mode: "yolo",
    window_state_id: "management-state", window_state_kind: "management", state: { state: {
      bounds: { x: -100, y: 80, width: 640, height: 800 }, bounds_source: "dwm_visible_frame",
      coordinate_space: "windows_desktop_pixels", minimized: false, maximized: true, visible: true,
      foreground_at_target: false, keyboard_focus_at_target: null, virtual_desktop: { on_current_desktop: null },
    } } } };
  const before = JSON.stringify(result), text = presentComputerResult(result);
  expect(text).toContain("computer:window-state/management-state");
  expect(text).toContain('{"x":-100,"y":80,"width":640,"height":800}');
  expect(text).toContain("source=dwm_visible_frame; unit=windows_desktop_pixels");
  expect(text).toContain("maximized=true");
  expect(text).toContain("keyboard_focus=null");
  expect(text).not.toContain("computer:observation/");
  expect(JSON.stringify(result)).toBe(before);
});
test("process health and OCR lines reach the presented text", () => {
  const hung: ComputerResult = { content: [], details: { status: "refused", mode: "yolo",
    process: { pid: 7, name: "mspaint", responding: false, memory_mb: 1900, cpu_seconds: 12 } } };
  expect(presentComputerResult(hung)).toContain("mspaint (pid 7) is NOT responding; 1900 MB memory");
  const read: ComputerResult = { content: [], details: { status: "observed", mode: "yolo", observation_id: "o",
    text_lines: [{ text: "Hello Agent 42", x: 10, y: 20, width: 88, height: 18, words: [] }] } };
  expect(presentComputerResult(read)).toContain('"Hello Agent 42" | x=10 y=20 w=88 h=18');
});
test("unknown management retains submitted prefix and constrained geometry without a raw dump", () => {
  const result: ComputerResult = { content: [], isError: true, details: { status: "unknown", mode: "yolo",
    state: { operation: "resize", mutation_attempted: true, mutation_accepted: true, postcondition_confirmed: false,
      requested_bounds: { x: 60, y: 60, width: 300, height: 400 },
      observed: { bounds: { x: 60, y: 60, width: 500, height: 400 }, bounds_source: "window_rect",
        minimized: false, maximized: false, visible: true, foreground_at_target: false, keyboard_focus_at_target: null },
      code: "window_management_timeout", private_native_data: "x".repeat(20000) } } };
  const before = JSON.stringify(result), text = presentComputerResult(result);
  expect(text).toContain("mutation_attempted=true, mutation_accepted=true, postcondition_confirmed=false");
  expect(text).toContain('"width":300');
  expect(text).toContain('"width":500');
  expect(text).toContain("source=window_rect");
  expect(text).toContain("keyboard_focus=null");
  expect(text).toContain("window_management_timeout");
  expect(text.length).toBeLessThan(1200);
  expect(JSON.stringify(result)).toBe(before);
});

test("schema-rejected management retains an explicitly unvalidated prefix without claiming delivered success", () => {
  const result: ComputerResult = { content: [], isError: true, details: { status: "unknown", mode: "yolo",
    state: { code: "tool_output_invalid", execution_state: "unknown", invalid_output: {
      operation: "focus", mutation_attempted: true, mutation_accepted: true, postcondition_confirmed: true, requested_bounds: null,
      observed: { minimized: false, maximized: false, visible: true, foreground_at_target: true, keyboard_focus_at_target: null },
    } } } };
  const before = JSON.stringify(result), text = presentComputerResult(result);
  expect(text).toContain("Computer unknown");
  expect(text).toContain("Unvalidated management: focus");
  expect(text).toContain("mutation_attempted=true, mutation_accepted=true, postcondition_confirmed=true");
  expect(text).toContain("keyboard_focus=null");
  expect(text).not.toContain("Computer delivered");
  expect(JSON.stringify(result)).toBe(before);
});
test("window state exposes its restore-only address and independent foreground/focus metadata", () => {
  const result: ComputerResult = { content: [], details: { status: "observed", mode: "yolo", window_state_id: "fresh-state",
    state: { minimized: true, visible: true, foreground_at_target: false, keyboard_focus_at_target: null } } };
  const text = presentComputerResult(result);
  expect(text).toContain("computer:window-state/fresh-state");
  expect(text).toContain("minimized=true, visible=true");
  expect(text).toContain("foreground=false, keyboard_focus=null");
  expect(text).toContain("restore");
  expect(text).not.toContain("computer:observation/");
});

test("interrupted restore presentation preserves mutation prefix without claiming focus or fresh paint", () => {
  const result: ComputerResult = { content: [], isError: true, details: { status: "unknown", mode: "yolo",
    state: { restore_attempted: true, restore_requested: true, restored: true, activation_attempted: true,
      activation_succeeded: false, visible: true, foreground_at_target: false, keyboard_focus_at_target: null } } };
  const text = presentComputerResult(result);
  expect(text).toContain("restore_attempted=true, restore_requested=true, restored=true");
  expect(text).toContain("activation_attempted=true, activation_succeeded=false");
  expect(text).toContain("foreground=false, keyboard_focus=null");
  expect(text).toContain("Never replay");
});

test("coordinate scroll presentation exposes native wheel units and interrupted axis prefixes", () => {
  const result: ComputerResult = { isError: true, content: [{ type: "text", text: "Coordinate scroll interrupted. Never replay unknown input." }],
    details: { status: "unknown", mode: "yolo", state: { unit: "wheel_detents", delta_x: -1, delta_y: 2,
      pointer_attempted: true, pointer_delivered: true, attempted_axes: ["y", "x"], delivered_axes: ["y"],
      code: "cancelled", private_native_data: "x".repeat(20_000) } } };
  const before = JSON.stringify(result), summary = presentComputerResult(result);
  expect(summary).toContain("delta_x=-1, delta_y=2; unit=wheel_detents");
  expect(summary).toContain("pointer_attempted=true, pointer_delivered=true");
  expect(summary).toContain('attempted_axes=["y","x"], delivered_axes=["y"]');
  expect(summary).toContain("cancelled");
  expect(summary).toContain("Never replay");
  expect(summary.length).toBeLessThan(1000);
  expect(JSON.stringify(result)).toBe(before);
});

test("action presentation keeps uncertainty and delivered prefixes without dumping native state", () => {
  const result: ComputerResult = { isError: true,
    content: [{ type: "text", text: 'Sequence refused: 1/2 steps delivered; 2 attempted. Never replay the completed prefix.\n{"large":"native dump"}' }],
    details: { status: "refused", mode: "yolo", state: { code: "background_unavailable", native_message: "Background delivery unavailable.",
      sequence: { completed: 1, attempted: 2, total: 2 }, private_native_data: "x".repeat(20_000) } } };
  const before = JSON.stringify(result);
  const text = presentComputerResult(result);
  expect(text).toContain("1/2 steps delivered");
  expect(text).toContain("background_unavailable");
  expect(text).toContain("Background delivery unavailable");
  expect(text).toContain("Never replay");
  expect(text.length).toBeLessThan(1000);
  expect(JSON.stringify(result)).toBe(before);
});

test("native image presentation keeps local geometry but not annotation or hash payloads", () => {
  const result: ComputerResult = { content: [], details: { status: "observed", mode: "yolo", observation_id: "snapshot",
    agent_image: { route: "cua_window", coordinate_space: "window_image_pixels", output: { width: 395, height: 500, mimeType: "image/png", hash: "private hash" },
      configuration: { maxLongEdge: 500, scale: 1 }, annotation: { labels: Array(100).fill({ token: "native-private-token" }) } } } };
  const text = presentComputerResult(result);
  expect(text).toContain("395x500");
  expect(text).toContain("window_image_pixels");
  expect(text).toContain("computer:observation/snapshot");
  expect(text).not.toContain("native-private-token");
  expect(text).not.toContain("private hash");
  expect(text.length).toBeLessThan(600);
  expect((result.details.agent_image!.annotation as { labels: unknown[] }).labels).toHaveLength(100);
});
