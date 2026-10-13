import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNativeWindowState } from "../scripts/native-window-state.mjs";

const targets = [{ pid: 42, window_id: 91 }, { pid: 43, window_id: 92 }];
const rows = [[92, -100, 200, 92], [91, 42, 1, 1, 1, 0, -1], [92, 43, 1, 0, 1, 1, 1]];

test("readonly exact-window metadata separates minimized state, foreground and unknown keyboard focus", () => {
  const state = parseNativeWindowState(JSON.stringify(rows), targets);
  assert.equal(state.status, "measured");
  assert.deepEqual(state.windows, [{ pid: 42, window_id: 91, owner_pid: 42, exists: true, minimized: true,
    visible: true, foreground_at_target: false, keyboard_focus_at_target: null },
  { pid: 43, window_id: 92, owner_pid: 43, exists: true, minimized: false,
    visible: true, foreground_at_target: true, keyboard_focus_at_target: true }]);
  assert.deepEqual(state.pointer, { x: -100, y: 200, space: "windows_desktop_pixels", read_only: true });
  assert.equal(state.foreground_window, 92);
});

test("closed or reused HWND reports no retained window-state measurements", () => {
  for (const owner of [0, 99]) {
    const changed = structuredClone(rows);
    changed[1] = [91, owner, 0, -1, -1, -1, -1];
    const state = parseNativeWindowState(JSON.stringify(changed), targets);
    assert.deepEqual(state.windows[0], { pid: 42, window_id: 91, owner_pid: owner, exists: false,
      minimized: null, visible: null, foreground_at_target: null, keyboard_focus_at_target: null });
  }
});

test("wrong target, owner or contradictory foreground measurements cannot pass as exact native state", () => {
  for (const change of [[1, 0, 100], [1, 1, 99], [2, 5, 0], [1, 3, 2]]) {
    const changed = structuredClone(rows);
    changed[change[0]][change[1]] = change[2];
    assert.throws(() => parseNativeWindowState(JSON.stringify(changed), targets));
  }
});

test("malformed or incomplete native measurements are rejected, not converted into empty success", () => {
  for (const value of [null, [], [[92, 1, 2, 92]], [...rows, rows[1]], [[92, 1.5, 2, 92], ...rows.slice(1)],
    [rows[0], [91, 0, 0, 0, -1, -1, -1], rows[2]], [rows[0], rows[1], [92, 43, 1, -1, 1, 1, 1]]])
    assert.throws(() => parseNativeWindowState(JSON.stringify(value), targets));
});

test("duplicate, oversized or invalid fixture identities are rejected before interpreting native output", () => {
  for (const value of [[], [...targets, { pid: 44, window_id: 93 }], [targets[0], targets[0]],
    [{ pid: 0, window_id: 91 }], [{ pid: 2147483648, window_id: 91 }], [{ pid: 42, window_id: 1.5 }]])
    assert.throws(() => parseNativeWindowState(JSON.stringify(rows), value));
});
