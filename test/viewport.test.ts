import sharp from "sharp";
import { describe, expect, test, vi } from "vitest";
import { computerSource, parseComputerAddress } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { presentComputerResult } from "../src/provider.ts";
import { ComputerSession, type ComputerResult, type Content, type Driver } from "../src/session.ts";
import type { ShortAddresses } from "../src/short-addresses.ts";
import { clipViewport, VIEWPORT_CAP, viewportImageSize, viewportPoint, viewportRect, windowPoint } from "../src/viewport.ts";

const cwd = "/synthetic-viewports";

// LPT-931: the agent names a rectangle of a window, reads it at the window's own resolution and acts in its pixels.
describe("viewport geometry", () => {
  test("a viewport keeps the window's resolution up to the cap, and points map both ways", () => {
    expect(viewportImageSize({ x: 0, y: 0, width: 300, height: 200 })).toEqual({ width: 300, height: 200 });
    expect(viewportImageSize({ x: 0, y: 0, width: 3136, height: 1000 })).toEqual({ width: VIEWPORT_CAP, height: 500 });
    const rect = { x: 100, y: 40, width: 3136, height: 1000 };
    expect(windowPoint(rect, { x: 10, y: 20 })).toEqual({ x: 120, y: 80 });
    expect(viewportPoint(rect, { x: 120, y: 80 })).toEqual({ x: 10, y: 20 });
    expect(windowPoint(rect, { x: VIEWPORT_CAP, y: 0 })).toBeUndefined();
    expect(windowPoint({ x: 5, y: 5, width: 50, height: 50 }, { x: 49, y: 49 })).toEqual({ x: 54, y: 54 });
  });

  test("a rectangle in the agent's image becomes full-resolution pixels, and missing fields keep the current ones", () => {
    expect(viewportRect({ x: 50, y: 50, width: 100, height: 60 }, { x: 2, y: 2 })).toEqual({ x: 100, y: 100, width: 200, height: 120 });
    expect(viewportRect({ x: 10 }, { x: 2, y: 2 }, { x: 100, y: 100, width: 200, height: 120 })).toEqual({ x: 20, y: 100, width: 200, height: 120 });
    expect(() => viewportRect({ x: 1, y: 1, width: 10 }, { x: 1, y: 1 })).toThrow("A new viewport needs x, y, width and height.");
    expect(() => viewportRect({ x: 1, y: 1, width: 2, height: 50 }, { x: 1, y: 1 })).toThrow("at least 8");
    expect(clipViewport({ x: 900, y: 600, width: 300, height: 100 }, { width: 1000, height: 640 })).toEqual({ x: 900, y: 600, width: 100, height: 40 });
    expect(clipViewport({ x: 995, y: 0, width: 300, height: 100 }, { width: 1000, height: 640 })).toBeUndefined();
  });

  test("a viewport address is its window's address with the viewport's name after it", () => {
    expect(parseComputerAddress("computer:window/w-1/pano")).toEqual({ kind: "viewport", source: "computer:window/w-1/pano", ref: "w-1", name: "pano" });
  });
});

/** A 1000x640 window whose captures honour max_image_dimension, with a blue mark at 150,150 and a dot wherever a click lands. */
async function fixture() {
  const FULL = { width: 1000, height: 640 };
  const dots: { x: number; y: number }[] = [];
  const scales = new Map<string, number>();
  let serial = 0, last = 1;
  const frame = async (scale: number) => {
    const shapes = [`<rect x="150" y="150" width="10" height="10" fill="#00f"/>`, ...dots.map(dot => `<rect x="${dot.x - 3}" y="${dot.y - 3}" width="6" height="6" fill="#c00"/>`)];
    const full = await sharp({ create: { ...FULL, channels: 3, background: "#fff" } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${FULL.width}" height="${FULL.height}">${shapes.join("")}</svg>`) }]).png().toBuffer();
    const png = scale === 1 ? full : await sharp(full).resize(Math.round(FULL.width * scale), Math.round(FULL.height * scale), { kernel: "nearest" }).png().toBuffer();
    return { type: "image" as const, mimeType: "image/png", data: png.toString("base64") };
  };
  const driver: Driver = {
    identity: vi.fn(async () => "life"), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      const input = args as { x?: number; y?: number; capture_id?: string; include_screenshot?: boolean; include_accessibility_tree?: boolean; max_image_dimension?: number; element_token?: string };
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name === "get_window_state") {
        serial++;
        const pixels = input.include_screenshot !== false, ui = input.include_accessibility_tree !== false;
        const scale = Math.min(1, (input.max_image_dimension ?? 1280) / FULL.width);
        if (pixels) { scales.set(`c${serial}`, scale); last = scale; }
        const width = Math.round(FULL.width * scale), height = Math.round(FULL.height * scale);
        return { content: pixels ? [await frame(scale)] : [], structuredContent: { pid: 42, window_id: 91, window_bounds: { x: 80, y: 90, ...FULL },
          ...(pixels ? { capture_id: `c${serial}`, screenshot_width: width, screenshot_height: height } : {}),
          ...(ui ? { snapshot_id: `s${serial}`, elements_complete: true, elements: [{ element_token: `s${serial}:0`, role: "Button", label: "Paint", enabled: true, actions: ["invoke"],
            frame: { x: 0, y: 0, w: 40, h: 20 }, ...(pixels ? { screenshot_frame: { x: 0, y: 0, w: Math.round(40 * scale), h: Math.round(20 * scale) } } : {}) }] } : {}) } };
      }
      // A pixel click paints a dot where it lands, in the window's full-resolution pixels; the button paints one at 900,600.
      if (name === "click") {
        if (input.element_token) dots.push({ x: 900, y: 600 });
        else {
          const scale = (input.capture_id ? scales.get(input.capture_id) : undefined) ?? last;
          dots.push({ x: Math.round(input.x! / scale), y: Math.round(input.y! / scale) });
        }
        return { content: [], structuredContent: { effect: "confirmed" } };
      }
      throw Error(`Unexpected native call ${name}`);
    }),
  };
  const session = new ComputerSession(driver, () => "yolo");
  const resources = new ComputerResources(async () => session, async () => session.close());
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const window = computerSource("window", ref);
  // The agent's view of the window: an overview half the window's size.
  const overview = async () => (await resources.read(requireComputerAddress(window), cwd, ["full", 'capture:{"maxLongEdge":500}']))!;
  return { resources, session, ref, window, dots, overview, pano: requireComputerAddress(`${window}/pano`) };
}
const images = (result: ComputerResult) => result.content.filter((block): block is Extract<Content, { type: "image" }> => block.type === "image");
const pixel = async (image: Extract<Content, { type: "image" }>, x: number, y: number) => {
  const { data, info } = await sharp(Buffer.from(image.data, "base64")).raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
};
const size = async (image: Extract<Content, { type: "image" }>) => {
  const { width, height } = await sharp(Buffer.from(image.data, "base64")).metadata();
  return { width, height };
};

describe("viewports of a window", () => {
  test("computer_view takes a rectangle of the agent's image and shows it at the window's own resolution", async () => {
    const f = await fixture();
    await f.overview();
    const made = await f.resources.view(f.pano, cwd, { x: 50, y: 50, width: 100, height: 60 });
    expect(made.details.viewport).toMatchObject({ name: "pano", window_ref: f.ref, rect: { x: 100, y: 100, width: 200, height: 120 }, image: { width: 200, height: 120 } });
    const [image] = images(made);
    expect(await size(image)).toEqual({ width: 200, height: 120 });
    // The mark at 150,150 of the window is at 50,50 of the viewport, one window pixel per image pixel.
    expect(await pixel(image, 52, 52)).toEqual([0, 0, 255]);
    const text = presentComputerResult(made);
    expect(text).toContain(`${f.window}/pano is 100x60 at 50,50 of the window's latest image. Its image is 200x120, the window's own resolution.`);
    expect(text).toContain(`Viewport: ${f.window}/pano; points on it are pixels of its 200x120 image`);
    // Moving keeps the size; a Read shows the moved rectangle.
    await f.resources.view(f.pano, cwd, { x: 60 });
    const read = (await f.resources.read(f.pano, cwd, []))!;
    expect(read.details.viewport?.rect).toEqual({ x: 120, y: 100, width: 200, height: 120 });
    expect(await pixel(images(read)[0], 32, 52)).toEqual([0, 0, 255]);
  });

  test("a viewport Read only looks: the window's refs stay current for input", async () => {
    const f = await fixture();
    const view = await f.overview();
    await f.resources.view(f.pano, cwd, { x: 50, y: 50, width: 100, height: 60 });
    await f.resources.read(f.pano, cwd, []);
    const hint = view.details.ui!.elements[0].hint;
    const clicked = await f.resources.input(requireComputerAddress(f.window), cwd, { label: "click", target: hint, native: { action: "click" }, web: "" });
    expect(clicked.details.status).toBe("delivered");
    expect(f.dots).toEqual([{ x: 900, y: 600 }]);
  });

  test("a point in a viewport lands at that pixel of the viewport, and the change list covers only the viewport", async () => {
    const f = await fixture();
    await f.overview();
    await f.resources.view(f.pano, cwd, { x: 50, y: 50, width: 100, height: 60 });
    const clicked = await f.resources.input(f.pano, cwd, { label: "click", point: { x: 10, y: 20 }, native: { action: "click" }, web: "" });
    expect(f.dots).toEqual([{ x: 110, y: 120 }]);
    expect(clicked.details.viewport).toMatchObject({ source: `${f.window}/pano`, window_ref: f.ref });
    expect(clicked.details.successor?.diff?.pixels).toMatchObject({ space: "viewport", width: 200, height: 120, box: { x: 7, y: 17, width: 6, height: 6 } });
    const text = presentComputerResult(clicked);
    expect(text).toContain(`Viewport: ${f.window}/pano`);
    expect(text).toMatch(/Pixels changed in 1 area \(pixels of the viewport's image; [\d.]+% of the viewport\)/);
    // A point of the window's latest image keeps its meaning after input in a viewport.
    await f.resources.input(requireComputerAddress(f.window), cwd, { label: "click", point: { x: 250, y: 160 }, native: { action: "click" }, web: "" });
    expect(f.dots.at(-1)).toEqual({ x: 500, y: 320 });
  });

  test("a capture the agent is not shown keeps the agent's latest image as the space of its points", async () => {
    const f = await fixture();
    await f.overview();
    // A UI-only Read leaves no pixels, so the click captures the window first; that capture is not the agent's image.
    await f.resources.read(requireComputerAddress(f.window), cwd, ["ui"]);
    await f.resources.input(requireComputerAddress(f.window), cwd, { label: "click", point: { x: 250, y: 160 }, native: { action: "click" }, web: "" });
    expect(f.dots).toEqual([{ x: 500, y: 320 }]);
  });

  test("a point outside the viewport's image and space refuse before anything is sent", async () => {
    const f = await fixture();
    await f.overview();
    await f.resources.view(f.pano, cwd, { x: 50, y: 50, width: 100, height: 60 });
    await expect(f.resources.input(f.pano, cwd, { label: "click", point: { x: 200, y: 5 }, native: { action: "click" }, web: "" }))
      .rejects.toThrow(`200,5 lies outside ${f.window}/pano: its image is 200x120.`);
    await expect(f.resources.input(f.pano, cwd, { label: "click", point: { x: 5, y: 5 }, space: "window", native: { action: "click" }, web: "" }))
      .rejects.toThrow("space does not apply in a viewport");
    expect(f.dots).toEqual([]);
  });

  test("viewports resolve by window name and short address, list in the session and go away with Delete", async () => {
    const f = await fixture();
    await f.overview();
    await f.resources.name(requireComputerAddress(f.window), cwd, "game");
    expect(f.resources.address("computer:game/pano")).toEqual(f.pano);
    await expect(f.resources.read(f.resources.address("computer:game/pano"), cwd, [])).rejects.toThrow("is no viewport yet");
    await f.resources.view(f.resources.address("computer:game/pano"), cwd, { x: 50, y: 50, width: 100, height: 60 });
    const tag = (f.resources as unknown as { shorts: ShortAddresses }).shorts.tag;
    expect(f.resources.shorten(`${f.window}/pano`)).toBe(`computer:local/w1${tag}/pano`);
    expect(f.resources.address(`computer:local/w1${tag}/pano`)).toEqual(f.pano);
    expect(f.resources.descriptor(requireComputerAddress("computer:session"))).toContain(`- ${f.window}/pano: 200x120 at 100,100 in full-resolution window pixels`);
    const removed = await f.resources.delete("computer:game/pano", cwd);
    expect(removed.details.status).toBe("closed");
    await expect(f.resources.read(f.pano, cwd, [])).rejects.toThrow("is no viewport yet");
  });

  test("a new viewport needs its whole rectangle inside the window", async () => {
    const f = await fixture();
    await f.overview();
    await expect(f.resources.view(f.pano, cwd, { x: 10, y: 10 })).rejects.toThrow("A new viewport needs x, y, width and height.");
    await expect(f.resources.view(f.pano, cwd, { x: 499, y: 10, width: 50, height: 50 })).rejects.toThrow("lies outside the window: its latest image is 500x320.");
  });
});
