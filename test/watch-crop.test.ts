import sharp from "sharp";
import { expect, test, vi } from "vitest";
import { ComputerSession, type Driver } from "../src/session.ts";

// LPT-950: a watch of a viewport asks the driver for the viewport only, in the window's physical pixels, so the driver
// encodes just that rectangle instead of the whole window; two captures may be in flight at once.
const target = { pid: 42, window_id: 100 };
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();

test("a viewport watch sends its rectangle as the driver crop and records the frames as cropped", async () => {
  let windows: object[] = [];
  const calls: Record<string, unknown>[] = [];
  let inFlight = 0, most = 0;
  const driver: Driver = {
    windowCrop: true,
    identity: vi.fn(async window => `${window.pid}:${window.window_id}`),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Big", launch_path: "C:\\Big\\big.exe" }] } };
      if (name === "launch_app") { windows = [{ ...target, title: "Big" }]; return { content: [{ type: "text", text: JSON.stringify({ pid: 42, windows }) }] }; }
      if (name !== "get_window_state") return { content: [], structuredContent: {} };
      calls.push(args);
      const full = { screenshot_original_width: 8192, screenshot_original_height: 5120 };
      if (!args.crop) {
        const cap = Number(args.max_image_dimension), width = Math.min(cap, 8192), height = Math.round(width * 5120 / 8192);
        return { content: [{ type: "image", mimeType: "image/png", data: (await png(width, height)).toString("base64") }],
          structuredContent: { ...target, ...full, screenshot_width: width, screenshot_height: height, snapshot_id: "s1", elements: [] } };
      }
      inFlight++; most = Math.max(most, inFlight);
      await new Promise(resolve => setTimeout(resolve, 120));
      inFlight--;
      const crop = args.crop as { x: number; y: number; width: number; height: number };
      const k = Math.min(1, Number(args.max_image_dimension) / Math.max(crop.width, crop.height));
      const width = Math.round(crop.width * k), height = Math.round(crop.height * k);
      return { content: [{ type: "image", mimeType: "image/png", data: (await png(width, height)).toString("base64") }],
        structuredContent: { ...target, ...full, screenshot_width: width, screenshot_height: height, screenshot_crop: crop, display_only: true } };
    }),
    close: vi.fn(async () => {}),
  };
  const session = new ComputerSession(driver, () => "yolo");
  const ref = (await session.open("Big")).details.window_ref!;
  // The viewport in pixels of the window's full-size image, which is at most 4096 px: this 8192 px window counts at 1/2.
  const started = await session.startWatch(ref, "viewport", { fps: 15, timeout_ms: 1500, maxLongEdge: 800, crop: { x: 100, y: 200, width: 400, height: 300 } });
  expect(started.details.status).toBe("observed");
  await new Promise(resolve => setTimeout(resolve, 900));
  const stopped = await session.stopWatch(started.details.watch!.sequence_id);
  const cropped = calls.filter(call => call.crop);
  // The rectangle in the window's physical pixels; display-only, so the image never becomes an input source.
  expect(cropped[0]).toMatchObject({ display_only: true, include_accessibility_tree: false, crop: { x: 200, y: 400, width: 800, height: 600 } });
  // The viewport keeps its size: 400x300 at most 800 on its long edge.
  expect(cropped[0].max_image_dimension).toBe(400);
  const frames = stopped.details.sequence!.frames;
  expect(frames[0].source.image).toMatchObject({ scope: "native_window_zoom", dimensions: { width: 400, height: 300 },
    origin: { x: 200, y: 400, relative_to: "window" }, crop: { coordinate_space: "window_physical_pixels", applied: { x: 200, y: 400, width: 800, height: 600 } } });
  // Captures of 120 ms at 15 FPS overlap, two at a time.
  expect(most).toBe(2);
  expect(frames.length).toBeGreaterThanOrEqual(9);
});
