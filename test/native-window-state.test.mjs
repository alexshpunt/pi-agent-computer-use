import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNativeWindowState } from "../scripts/native-window-state.mjs";

const targets = [{ pid: 42, window_id: 91 }, { pid: 43, window_id: 92 }];
// Window rows: handle, owner, exists, minimized, visible, foreground, focus, maximized, outer L/T/R/B, dpi,
// then DWM status (1 measured, 0 HRESULT failure, -1 closed, -2 missing API, -3 unavailable frame), HRESULT, visible L/T/R/B.
const rows = [[92, -100, 200, 92], [91, 42, 1, 1, 1, 0, -1, 0, -32000, -32000, -31840, -31972, 144,
  0, -2147024891, 0, 0, 0, 0], [92, 43, 1, 0, 1, 1, 1, 1, -100, 60, 900, 860, 192,
  1, 0, -92, 68, 892, 852]];
const bounds = (x, y, width, height) => ({ x, y, width, height, space: "windows_desktop_pixels", read_only: true,
  route: "GetWindowRect", includes_invisible_resize_borders: true });
const frameError = (code, hresult = null) => ({ source: "dwm_extended_frame_bounds", status: "unavailable", bounds: null,
  error: { code, hresult } });

test("readonly exact-window metadata separates geometry, DPI, minimized and maximized state, foreground and unknown focus", () => {
  const state = parseNativeWindowState(JSON.stringify(rows), targets);
  assert.equal(state.status, "measured");
  assert.deepEqual(state.windows, [{ pid: 42, window_id: 91, owner_pid: 42, exists: true, minimized: true,
    visible: true, foreground_at_target: false, keyboard_focus_at_target: null, maximized: false,
    bounds: bounds(-32000, -32000, 160, 28), dpi: 144, visible_frame: frameError("dwm_query_failed", -2147024891) },
  { pid: 43, window_id: 92, owner_pid: 43, exists: true, minimized: false,
    visible: true, foreground_at_target: true, keyboard_focus_at_target: true, maximized: true,
    bounds: bounds(-100, 60, 1000, 800), dpi: 192, visible_frame: { source: "dwm_extended_frame_bounds", status: "measured",
      bounds: { x: -92, y: 68, width: 984, height: 784, space: "windows_desktop_pixels", read_only: true,
        route: "DwmGetWindowAttribute:DWMWA_EXTENDED_FRAME_BOUNDS" }, error: null } }]);
  assert.notDeepEqual(state.windows[1].bounds, state.windows[1].visible_frame.bounds);
  assert.deepEqual(state.pointer, { x: -100, y: 200, space: "windows_desktop_pixels", read_only: true });
  assert.equal(state.foreground_window, 92);
});

test("closed or reused HWND reports no retained window state, bounds, visible frame or DPI", () => {
  for (const owner of [0, 99]) {
    const changed = structuredClone(rows);
    changed[1] = [91, owner, 0, -1, -1, -1, -1, -1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0];
    const state = parseNativeWindowState(JSON.stringify(changed), targets);
    assert.deepEqual(state.windows[0], { pid: 42, window_id: 91, owner_pid: owner, exists: false,
      minimized: null, visible: null, foreground_at_target: null, keyboard_focus_at_target: null,
      maximized: null, bounds: null, dpi: null, visible_frame: frameError("window_unavailable") });
    for (const index of [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]) {
      const retained = structuredClone(changed);
      retained[1][index] = [7, 13].includes(index) ? 0 : 1;
      assert.throws(() => parseNativeWindowState(JSON.stringify(retained), targets));
    }
  }
});

test("DWM failure, missing API or empty visible frame keeps outer bounds without inventing DWM success", () => {
  for (const [status, hresult, code] of [[0, -2147024891, "dwm_query_failed"], [-2, 0, "dwm_api_unavailable"],
    [-3, 0, "dwm_frame_unavailable"]]) {
    const changed = structuredClone(rows);
    changed[2].splice(13, 6, status, hresult, 0, 0, 0, 0);
    const state = parseNativeWindowState(JSON.stringify(changed), targets);
    assert.deepEqual(state.windows[1].bounds, bounds(-100, 60, 1000, 800));
    assert.equal(state.windows[1].dpi, 192);
    assert.deepEqual(state.windows[1].visible_frame, frameError(code, status === -2 ? null : hresult));
  }
});

test("contradictory DWM source, HRESULT and retained or malformed visible geometry are rejected", () => {
  for (const value of [[1, -1, -92, 68, 892, 852], [0, 0, 0, 0, 0, 0], [-1, 0, 0, 0, 0, 0],
    [-2, -1, 0, 0, 0, 0], [-3, -1, 0, 0, 0, 0], [3, 0, 0, 0, 0, 0], [0, -1, -92, 68, 892, 852],
    [-2, 0, 0, 0, 1, 0], [-3, 0, 0, 0, 1, 0], [1, 1.5, -92, 68, 892, 852],
    [0, -2147483649, 0, 0, 0, 0], [1, 0, -92.5, 68, 892, 852], [1, 0, -92, 68, -92, 852],
    [1, 0, -92, 68, -93, 852], [1, 0, -92, 68, 892, 68], [1, 0, -2147483649, 68, 892, 852]]) {
    const changed = structuredClone(rows);
    changed[2].splice(13, 6, ...value);
    assert.throws(() => parseNativeWindowState(JSON.stringify(changed), targets));
  }
});

test("wrong target, owner or contradictory foreground measurements cannot pass as exact native state", () => {
  for (const change of [[1, 0, 100], [1, 1, 99], [2, 5, 0], [1, 3, 2], [2, 7, -1]]) {
    const changed = structuredClone(rows);
    changed[change[0]][change[1]] = change[2];
    assert.throws(() => parseNativeWindowState(JSON.stringify(changed), targets));
  }
});

test("non-integral, empty, inverted or out-of-range native bounds and DPI are rejected", () => {
  for (const [index, value] of [[8, 1.5], [9, null], [8, -2147483649], [11, 2147483648],
    [10, -100], [10, -101], [11, 60], [11, 59], [12, 0], [12, -1], [12, 1.5], [12, 4294967296]]) {
    const changed = structuredClone(rows);
    changed[2][index] = value;
    assert.throws(() => parseNativeWindowState(JSON.stringify(changed), targets));
  }
});

test("malformed or incomplete native measurements are rejected, not converted into empty success", () => {
  for (const value of [null, [], [[92, 1, 2, 92]], [...rows, rows[1]], [[92, 1.5, 2, 92], ...rows.slice(1)],
    [rows[0], null, rows[2]], [rows[0], [91, 42, 1, 1, 1, 0, -1], rows[2]],
    [rows[0], [91, 0, 0, 0, -1, -1, -1, -1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0], rows[2]],
    [rows[0], rows[1], [92, 43, 1, -1, 1, 1, 1, 0, -100, 60, 900, 860, 96, 0, -1, 0, 0, 0, 0]]])
    assert.throws(() => parseNativeWindowState(JSON.stringify(value), targets));
});

test("duplicate, oversized or invalid fixture identities are rejected before interpreting native output", () => {
  for (const value of [[], [...targets, { pid: 44, window_id: 93 }], [targets[0], targets[0]],
    [{ pid: 0, window_id: 91 }], [{ pid: 2147483648, window_id: 91 }], [{ pid: 42, window_id: 1.5 }]])
    assert.throws(() => parseNativeWindowState(JSON.stringify(rows), value));
});
