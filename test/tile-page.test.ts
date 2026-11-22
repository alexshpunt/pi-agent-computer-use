import { expect, test } from "vitest";
import { justifiedLayout, layoutLayers, MIN_SCALE, splitRows } from "../native/tile-host/page/layout.js";
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

/** Window sizes as agents' sessions (1024x768 desktops) produce them: dialogs, tools and nearly maximized apps. */
const SIZES = [[1024, 738], [480, 320], [800, 600], [640, 480], [1000, 700], [400, 500], [720, 540], [300, 200]] as const;
const windows = (count: number) => Array.from({ length: count }, (_, key) => ({ key, width: SIZES[key % SIZES.length][0], height: SIZES[key % SIZES.length][1] }));
/** A 2560x1440 display and a 1366x768 laptop, each without a 48 px taskbar. */
const DESKTOP = { x: 0, y: 0, width: 2560, height: 1392 }, LAPTOP = { x: 0, y: 0, width: 1366, height: 720 };

test("tiles keep their window's aspect, never upscale and never overlap, inside the area, with the caption above", () => {
  for (const area of [DESKTOP, LAPTOP, { x: 100, y: 50, width: 1920, height: 1032 }]) for (let count = 1; count <= 20; count++) {
    const input = windows(count);
    const layers = layoutLayers(input, area);
    // Every window is on exactly one layer.
    expect(layers.flatMap(layer => [...layer.tiles.keys()]).sort((a, b) => a - b)).toEqual(input.map(w => w.key));
    for (const layer of layers) {
      const rects = [...layer.tiles.values()];
      for (const [key, r] of layer.tiles) {
        const w = input[key];
        expect(r.scale).toBeLessThanOrEqual(1);
        expect(r.width).toBeLessThanOrEqual(w.width);
        // Rounding to whole pixels moves the aspect by at most half a pixel on each side.
        expect(Math.abs(r.width / r.height - w.width / w.height)).toBeLessThanOrEqual((w.width / w.height) / r.height + 1 / r.height);
        expect(r.x).toBeGreaterThanOrEqual(area.x); expect(r.y - 28).toBeGreaterThanOrEqual(area.y);
        expect(r.x + r.width).toBeLessThanOrEqual(area.x + area.width); expect(r.y + r.height).toBeLessThanOrEqual(area.y + area.height);
      }
      for (const a of rects) for (const b of rects) if (a !== b)
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y - 28 || b.y + b.height <= a.y - 28).toBe(true);
    }
  }
});

test("windows that would get too small go to further layers, split evenly, in their order", () => {
  for (const area of [DESKTOP, LAPTOP]) for (let count = 1; count <= 20; count++) {
    const layers = layoutLayers(windows(count), area);
    // A layer below the readable minimum holds a single window that cannot be shown larger.
    for (const layer of layers) if (layer.tiles.size > 1) expect(layer.scale).toBeGreaterThanOrEqual(MIN_SCALE);
    // Windows keep their order across the layers.
    expect(layers.flatMap(layer => [...layer.tiles.keys()])).toEqual(windows(count).map(w => w.key));
  }
  // Windows of one size split evenly: no lone leftover layer.
  const large = (count: number) => Array.from({ length: count }, (_, key) => ({ key, width: 1024, height: 738 }));
  const sizes = (input: { key: number; width: number; height: number }[], area: typeof DESKTOP) => layoutLayers(input, area).map(layer => layer.tiles.size);
  expect(sizes(large(14), DESKTOP)).toEqual([14]);
  expect(sizes(large(20), DESKTOP)).toEqual([10, 10]);
  expect(sizes(large(30), DESKTOP)).toEqual([15, 15]);
  expect(sizes(large(14), LAPTOP)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  // Mixed windows: 14 fit one desktop layer; a laptop needs four.
  expect(sizes(windows(14), DESKTOP)).toEqual([14]);
  expect(sizes(windows(14), LAPTOP)).toEqual([4, 4, 3, 3]);
  // The page lays out on its main thread: a long list on a laptop takes well under a second (10 s before the row and
  // count bounds in layout.js).
  const started = performance.now();
  expect(layoutLayers(windows(100), LAPTOP).flatMap(layer => [...layer.tiles.keys()])).toHaveLength(100);
  expect(performance.now() - started).toBeLessThan(2000);
});

test("justified rows fill the desktop better than one common scale would", () => {
  // LPT-1676 measured 62-68 % for one scale on 2560x1392 and 76-81 % for justified rows. Tiles never upscale, so
  // only windows that are together larger than the area can fill it.
  const big = [[1024, 738], [800, 600], [1000, 700], [720, 540], [1024, 738], [640, 480]].map(([width, height], key) => ({ key, width, height }));
  expect(justifiedLayout(big, DESKTOP)!.fill).toBeGreaterThan(0.75);
  // One small window shows at its own size, centred.
  const one = justifiedLayout([{ key: "a", width: 480, height: 320 }], DESKTOP)!.tiles.get("a")!;
  expect(one).toMatchObject({ width: 480, height: 320, scale: 1 });
  expect(Math.abs(one.x + one.width / 2 - DESKTOP.width / 2)).toBeLessThanOrEqual(1);
  // A small window in a row of large ones keeps its own size and leaves the rest of the width to them: the row is
  // as wide as the area allows, without an empty slot around the small tile.
  const row = justifiedLayout([{ key: 0, width: 1024, height: 738 }, { key: 1, width: 300, height: 200 }, { key: 2, width: 1024, height: 738 }],
    { x: 0, y: 0, width: 2000, height: 800 }, { gap: 16 })!;
  const [a, b, c] = [0, 1, 2].map(key => row.tiles.get(key)!);
  expect(b).toMatchObject({ width: 300, height: 200, scale: 1 });
  expect(b.x - (a.x + a.width)).toBeLessThanOrEqual(17);
  expect(c.x - (b.x + b.width)).toBeLessThanOrEqual(17);
  expect(layoutLayers([], DESKTOP)).toEqual([]);
  // A layout is a function of the windows and the area: the same input places every tile the same.
  expect(layoutLayers(windows(9), DESKTOP)).toEqual(layoutLayers(windows(9), DESKTOP));
});

test("rows split in order with similar aspect sums and none empty", () => {
  const input = [{ width: 400, height: 400 }, { width: 400, height: 400 }, { width: 800, height: 400 }, { width: 400, height: 400 }];
  expect(splitRows(input, 2).map(row => row.length)).toEqual([2, 2]);
  expect(splitRows(input, 4).map(row => row.length)).toEqual([1, 1, 1, 1]);
});
