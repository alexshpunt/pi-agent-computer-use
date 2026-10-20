import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { computerSource } from "../src/computer-address.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";
import { ComputerSession, type Content, type Driver, type DriverResult } from "../src/session.ts";

const cwd = "/synthetic-regions-fixture";

// LPT-836: regions come from the observation's own capture, in overview pixels; without perception the view refuses.
async function fixture(parse: (args: Record<string, unknown>) => DriverResult) {
  const png = await sharp({ create: { width: 500, height: 320, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const image: Content = { type: "image", mimeType: "image/png", data: png.toString("base64") };
  let serial = 0;
  const driver: Driver = {
    identity: vi.fn(async () => "life"), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name === "get_window_state") return { content: [image], structuredContent: { pid: 42, window_id: 91, snapshot_id: `s${++serial}`,
        capture_id: `capture-${serial}`, screenshot_width: 500, screenshot_height: 320, window_bounds: { x: 0, y: 0, width: 1000, height: 640 }, elements_complete: true, elements: [] } };
      if (name === "parse_visual_regions") return parse(args);
      throw Error(`Unexpected native call ${name}`);
    }),
  };
  const session = new ComputerSession(driver, () => "yolo");
  const resources = new ComputerResources(async () => session, async () => session.close());
  const ref = ((await session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  return { driver, resources, window: requireComputerAddress(computerSource("window", ref)) };
}

test("regions parse the observation's own capture and report boxes in its overview pixels", async () => {
  const f = await fixture(() => ({ content: [], structuredContent: { capture: { screenshot: { width: 1000 } },
    regions: [{ kind: "icon", bounds: { x: 100, y: 40, width: 20, height: 30 }, label: "icon-class-0", confidence: 0.812 },
      { kind: "text", bounds: { x: 200, y: 400, width: 60, height: 10 }, text: "Save", confidence: 0.9 }] } }));
  const read = await f.resources.read(f.window, cwd, ["regions"]);
  const capture = vi.mocked(f.driver.call).mock.calls.find(([name]) => name === "get_window_state");
  expect(vi.mocked(f.driver.call).mock.calls.find(([name]) => name === "parse_visual_regions")![1]).toMatchObject({ capture_id: "capture-1" });
  expect(capture).toBeTruthy();
  expect(read!.details.visual_regions).toEqual([{ kind: "icon", x: 50, y: 20, width: 10, height: 15, confidence: 0.81 },
    { kind: "text", x: 100, y: 200, width: 30, height: 5, text: "Save", confidence: 0.9 }]);
  // The same observation can be parsed again without another capture.
  const again = await f.resources.read(requireComputerAddress(computerSource("observation", read!.details.observation_id!)), cwd, ["regions"]);
  expect(again!.details.visual_regions).toHaveLength(2);
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "get_window_state")).toHaveLength(1);
});

test("a machine without the perception extension refuses regions with the driver's reason", async () => {
  const f = await fixture(() => ({ isError: true, content: [{ type: "text", text: "the optional cua-perception extension is not installed" }] }));
  await expect(f.resources.read(f.window, cwd, ["regions"])).rejects.toThrow(/Visual region detection failed: the optional cua-perception extension is not installed/);
  for (const views of [["regions", "ui"], ["regions", "ocr"], ["regions", "changes"]])
    await expect(f.resources.read(f.window, cwd, views)).rejects.toThrow();
});
