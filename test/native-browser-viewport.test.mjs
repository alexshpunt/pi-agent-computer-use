import assert from "node:assert/strict";
import test from "node:test";
import { parseNativeBrowserViewport } from "../scripts/native-browser-viewport.mjs";

const target = { pid: 42, window_id: 91 };
const root = [91, 42, 1, 0, -1440, 30, -90, 990, 5, 1];
const candidate = [92, 1, -1431, 150, -99, 981];
const parse = rows => parseNativeBrowserViewport(JSON.stringify(rows), target);

test("one fully measured native widget retains physical viewport and exact-root identity", () => {
  const state = parse([root, candidate]);
  assert.equal(state.status, "measured");
  assert.deepEqual(state.target, target);
  assert.deepEqual(state.bounds, { x: -1440, y: 30, width: 1350, height: 960 });
  assert.deepEqual(state.viewport, { x: -1431, y: 150, width: 1332, height: 831 });
  assert.equal(state.coordinate_space, "windows_desktop_pixels");
  assert.equal(state.read_only, true);
});
test("unmeasured or multiple candidates and incomplete scans cannot claim unique viewport", () => {
  assert.equal(parse([root]).status, "ambiguous");
  assert.equal(parse([root, candidate, [93, 1, -1431, 150, -99, 981]]).status, "ambiguous");
  const unknown = parse([root, candidate, [93, 0, 0, 0, 0, 0]]);
  assert.equal(unknown.status, "unavailable");
  assert.equal(unknown.viewport, null);
  const incomplete = [...root]; incomplete[9] = 0;
  assert.equal(parse([incomplete, candidate]).status, "unavailable");
});
test("substituted owners, invalid geometry and retained bounds on failed candidates reject", () => {
  const foreign = [...root]; foreign[1] = 43;
  assert.throws(() => parse([foreign, candidate]), /owner/);
  const invalid = [...candidate]; invalid[4] = invalid[2];
  assert.throws(() => parse([root, invalid]), /bounds/);
  assert.throws(() => parse([root, candidate, [93, 0, 1, 0, 0, 0]]), /unavailable/);
  assert.throws(() => parse([root, candidate, candidate]), /Duplicate/);
  const outside = [...candidate]; outside[2] = -1441;
  assert.throws(() => parse([root, outside]), /outside/);
  assert.throws(() => parseNativeBrowserViewport("[]", target), /row/);
});
