import sharp from "sharp";
import { expect, test, vi } from "vitest";
import { renderFrames, validateRendering } from "../src/contact-sheet.ts";
import { parseComputerViews } from "../src/computer-views.ts";
import { presentComputerResult } from "../src/provider.ts";
import { ComputerSession, type Driver } from "../src/session.ts";
import type { SequenceFrame } from "../src/temporal-capture.ts";

/** A frame of solid colour with one bright pixel at (spot, spot). */
async function frame(index: number, width = 64, height = 48, spot?: number, background = { r: 40, g: 40, b: 40 }): Promise<SequenceFrame> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) { raw[i] = background.r; raw[i + 1] = background.g; raw[i + 2] = background.b; }
  if (spot !== undefined) raw.fill(255, (spot * width + spot) * 3, (spot * width + spot) * 3 + 3);
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return { index, slot: index, timestamp_ms: index * 100, capture_started_ms: 0, capture_latency_ms: 0, sample_latency_ms: 0, hash: String(index), bytes: png.length,
    geometry_changed: false, source: {} as SequenceFrame["source"], image: { type: "image", mimeType: "image/png", data: png.toString("base64") } };
}
const pixel = async (png: Buffer, x: number, y: number) => {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
};

// LPT-925: many frames come back as one image the agent reads at once.
test("a sheet tiles frames in time order under their index and time labels, within the size limit", async () => {
  const frames = await Promise.all(Array.from({ length: 16 }, (_, i) => frame(i, 640, 400)));
  const sheet = await renderFrames(frames, { as: "sheet" });
  expect({ columns: sheet.columns, rows: sheet.rows }).toEqual({ columns: 4, rows: 4 });
  expect(Math.max(sheet.width, sheet.height)).toBeLessThanOrEqual(1600);
  expect((await sharp(sheet.png).metadata()).width).toBe(sheet.width);
  expect(sheet.tiles.map(tile => tile.index)).toEqual(frames.map(f => f.index));
  // Tile 6 is row 2, column 2, below its label strip.
  expect(sheet.tiles[5]).toMatchObject({ x: sheet.tiles[0].width, y: 2 * 18 + sheet.tiles[0].height, timestamp_ms: 500 });
  // The label strip carries white text on black.
  const { data, info } = await sharp(sheet.png).extract({ left: 0, top: 0, width: sheet.tiles[0].width, height: 18 }).raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] > 200) bright++;
  expect(bright).toBeGreaterThan(10);
  // Columns and a larger limit are honoured: 16 frames of a 640 px region keep full size in a 2-column 1280 px sheet.
  const wide = await renderFrames(frames.slice(0, 4), { as: "sheet", columns: 2, maxLongEdge: 1600 });
  expect({ columns: wide.columns, rows: wide.rows, tile: wide.tiles[0].width }).toEqual({ columns: 2, rows: 2, tile: 640 });
});

test("a region crops every frame first and is clipped to the frames", async () => {
  const frames = await Promise.all([0, 1].map(i => frame(i, 64, 48, 10)));
  const sheet = await renderFrames(frames, { as: "sheet", region: { x: 8, y: 8, width: 100, height: 100 } });
  expect(sheet.region).toEqual({ x: 8, y: 8, width: 56, height: 40 });
  expect(sheet.tiles[0]).toMatchObject({ width: 56, height: 40 });
  // The bright pixel at (10,10) is at (2,2) of the cropped tile.
  expect(await pixel(sheet.png, sheet.tiles[0].x + 2, sheet.tiles[0].y + 2)).toEqual([255, 255, 255]);
  await expect(renderFrames(frames, { as: "sheet", region: { x: 100, y: 0, width: 10, height: 10 } })).rejects.toThrow(/outside the 64x48 frames/);
});

test("max and min composites combine every frame per pixel", async () => {
  const frames = await Promise.all([frame(0, 32, 32, 3), frame(1, 32, 32, 20)]);
  const max = await renderFrames(frames, { as: "max" });
  expect(await pixel(max.png, 3, 3)).toEqual([255, 255, 255]);
  expect(await pixel(max.png, 20, 20)).toEqual([255, 255, 255]);
  expect(await pixel(max.png, 10, 10)).toEqual([40, 40, 40]);
  const min = await renderFrames([await frame(0, 32, 32), await frame(1, 32, 32, undefined, { r: 10, g: 90, b: 40 })], { as: "min" });
  expect(await pixel(min.png, 5, 5)).toEqual([10, 40, 40]);
  await expect(renderFrames([await frame(0, 32, 32), await frame(1, 40, 32)], { as: "max" })).rejects.toThrow(/frames of one size/);
});

test("frames views take a selection with rendering options and refuse invalid ones before reading", () => {
  expect(parseComputerViews(['frames:{"as":"sheet"}'])).toEqual({ kind: "frames", selection: "all", rendering: { as: "sheet" } });
  expect(parseComputerViews(['frames:{"select":"changed","as":"max","region":{"x":0,"y":0,"width":10,"height":10}}']))
    .toEqual({ kind: "frames", selection: "changed", rendering: { as: "max", region: { x: 0, y: 0, width: 10, height: 10 } } });
  expect(parseComputerViews(['frames:{"from":0,"to":15,"as":"sheet","columns":4,"maxLongEdge":2048}']))
    .toEqual({ kind: "frames", selection: { from: 0, to: 15 }, rendering: { as: "sheet", columns: 4, maxLongEdge: 2048 } });
  expect(parseComputerViews(['frames:{"indexes":[1,3]}'])).toEqual({ kind: "frames", selection: { indexes: [1, 3] } });
  for (const bad of [{ as: "video" }, { as: "max", columns: 2 }, { region: { x: 0, y: 0, width: 5, height: 5 } }, { as: "sheet", maxLongEdge: 10 },
    { as: "sheet", region: { x: -1, y: 0, width: 5, height: 5 } }, { as: "sheet", columns: 11 }])
    expect(() => validateRendering(bad)).toThrow();
  expect(() => parseComputerViews(['frames:{"select":"some","as":"sheet"}'])).toThrow(/select is/);
});

test("a sheet Read of a retained sequence returns one image and lists each tile", async () => {
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "red" } }).png().toBuffer();
  const driver: Driver = {
    identity: vi.fn(async () => "life"), close: vi.fn(async () => {}),
    call: vi.fn(async (name: string) => name === "list_windows" ? { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } } :
      { content: [{ type: "image" as const, mimeType: "image/png", data: png.toString("base64") }], structuredContent: { pid: 42, window_id: 91,
        window_bounds: { x: 10, y: 20, width: 40, height: 30 }, screenshot_width: 40, screenshot_height: 30, screenshot_original_width: 40, screenshot_original_height: 30, elements: [] } }),
  };
  const session = new ComputerSession(driver, () => "yolo");
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const captured = await session.captureSequence({ window_ref: ref }, { duration_ms: 400, fps: 10, max_frames: 3 });
  const id = captured.details.sequence!.sequence_id;
  const sheet = await session.sequenceFrames(id, "all", undefined, { as: "sheet" });
  expect(sheet.details.status).toBe("observed");
  expect(sheet.content.filter(block => block.type === "image")).toHaveLength(1);
  expect(sheet.details.rendered_frames!.tiles).toHaveLength(3);
  expect(presentComputerResult(sheet)).toMatch(/Contact sheet of 3 frames: 2x2 tiles[\s\S]*Tile 3 \(row 2, column 1\): frame 2 at/);
  const refused = await session.sequenceFrames(id, "all", undefined, { as: "max", region: { x: 50, y: 0, width: 5, height: 5 } });
  expect(refused.details.status).toBe("refused");
  expect(presentComputerResult(refused)).toMatch(/Frames not rendered: The region .* outside/);
});
