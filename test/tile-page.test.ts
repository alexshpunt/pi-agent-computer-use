import { expect, test } from "vitest";
import { gridLayout } from "../native/tile-host/page/layout.js";
import { codecFromAnnexB, cursorInTile, maxDimensionFor, parseFrame, stableOrder, tileWindows, type StreamWindow } from "../native/tile-host/page/stream.js";

const win = (id: string, over: Partial<StreamWindow> = {}): StreamWindow => ({ id, title: id, app: "app", pid: 1, bounds: { x: 0, y: 0, width: 480, height: 320 },
  state: "normal", kind: "standard", focused: false, onScreen: true, z: 0, ...over });

test("the decoder's codec string comes from the keyframe's SPS, with either start code", () => {
  // OpenH264 constrained baseline, level 3.1: SPS 67 42 c0 1f after a 4-byte start code, behind an access unit delimiter.
  expect(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda]))).toBe("avc1.42c01f");
  expect(codecFromAnnexB(new Uint8Array([0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac]))).toBe("avc1.640028");
  expect(codecFromAnnexB(new Uint8Array([0, 0, 0, 1, 0x41, 0x9a, 0, 0, 1, 0x41]))).toBeUndefined();
});

test("a hub frame splits into its header and payload", () => {
  const header = new TextEncoder().encode(JSON.stringify({ window: "w", keyframe: true }));
  const buffer = new Uint8Array(4 + header.length + 3);
  new DataView(buffer.buffer).setUint32(0, header.length);
  buffer.set(header, 4); buffer.set([7, 8, 9], 4 + header.length);
  const { header: parsed, payload } = parseFrame(buffer.buffer);
  expect(parsed).toEqual({ window: "w", keyframe: true });
  expect([...payload]).toEqual([7, 8, 9]);
});

test("only app windows and dialogs of a visible size get tiles, in the order they first appeared", () => {
  const windows = [win("a"), win("tip", { kind: "tooltip" }), win("min", { state: "minimized" }), win("off", { onScreen: false }),
    win("tiny", { bounds: { x: 0, y: 0, width: 30, height: 300 } }), win("overlay", { title: "Cua.AgentCursorOverlay.default", kind: "unspecified" }),
    win("d", { kind: "dialog" })];
  expect(tileWindows(windows).map(w => w.id)).toEqual(["a", "d"]);
  const order = new Map<string, number>();
  expect(stableOrder([win("b"), win("a")], order).map(w => w.id)).toEqual(["b", "a"]);
  // A window raised to the front keeps its tile's place; a new one goes last.
  expect(stableOrder([win("c"), win("a"), win("b")], order).map(w => w.id)).toEqual(["b", "a", "c"]);
});

test("tiles ask for frames as large as they show, and the cursor lands at the agent's point", () => {
  expect(maxDimensionFor(300, 200, 1.5)).toBe(512);
  expect(maxDimensionFor(10, 10, 1)).toBe(64);
  expect(cursorInTile({ x: 110, y: 70 }, { x: 10, y: 20, width: 480, height: 320 }, 0.5)).toEqual({ x: 50, y: 25 });
  expect(cursorInTile({ x: 5, y: 70 }, { x: 10, y: 20, width: 480, height: 320 }, 0.5)).toBeUndefined();
  expect(cursorInTile(undefined, { x: 10, y: 20, width: 480, height: 320 }, 0.5)).toBeUndefined();
});

test("the grid keeps every tile inside the area, apart, at its window's aspect and never upscaled", () => {
  const area = { x: 100, y: 50, width: 2560, height: 1392 };
  for (const count of [1, 2, 3, 6, 7, 14]) {
    const windows = Array.from({ length: count }, (_, i) => ({ key: i, width: i % 3 ? 480 : 1024, height: i % 3 ? 320 : 768 }));
    const placed = gridLayout(windows, area, { caption: 28, gap: 16 });
    expect(placed.size).toBe(count);
    const rects = [...placed.values()];
    windows.forEach(w => {
      const r = placed.get(w.key)!;
      expect(r.scale).toBeLessThanOrEqual(1);
      expect(Math.abs(r.width / r.height - w.width / w.height)).toBeLessThan(0.02);
      expect(r.x).toBeGreaterThanOrEqual(area.x); expect(r.y - 28).toBeGreaterThanOrEqual(area.y);
      expect(r.x + r.width).toBeLessThanOrEqual(area.x + area.width); expect(r.y + r.height).toBeLessThanOrEqual(area.y + area.height);
    });
    for (const a of rects) for (const b of rects) if (a !== b)
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y - 28 || b.y + b.height <= a.y - 28).toBe(true);
  }
  // One small window shows at its own size.
  expect(gridLayout([{ key: "a", width: 480, height: 320 }], area).get("a")).toMatchObject({ width: 480, height: 320, scale: 1 });
  expect(gridLayout([], area).size).toBe(0);
});
