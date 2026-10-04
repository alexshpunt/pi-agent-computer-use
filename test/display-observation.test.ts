import { expect, test, vi } from "vitest";
import { ComputerSession, type ComputerMode, type Driver } from "../src/session.ts";
import { CuaImageSettings } from "../src/cua-image-settings.ts";

const image = { type: "image" as const, mimeType: "image/png", data: "native-bytes-unchanged" };
function fixture() {
  let mode: ComputerMode = "yolo";
  const images = new CuaImageSettings();
  const driver: Driver = {
    call: vi.fn<Driver["call"]>(async () => ({ content: [image], structuredContent: {
      display: "primary", platform: "windows", capture_id: "display-capture", screen_width: 3840, screen_height: 2560,
      screenshot_original_width: 3840, screenshot_original_height: 2560, screenshot_width: 499, screenshot_height: 333, scale_factor: 1.5,
    } })),
    identity: vi.fn(async () => "window-lifetime"), close: vi.fn(async () => {}),
  };
  return { driver, images, session: new ComputerSession(driver, () => mode, () => images.settings()),
    setMode(value: ComputerMode) { mode = value; } };
}

test("YOLO display reading preserves native bytes, dimensions and a read-only Windows source", async () => {
  const f = fixture(); const result = await f.session.observeDisplay("primary");
  expect(result.details.status).toBe("observed"); expect(result.content).toContainEqual(image);
  expect(f.driver.call).toHaveBeenCalledExactlyOnceWith("get_desktop_state", { max_image_dimension: 500 }, undefined);
  expect(result.details.source).toMatchObject({ kind: "display", domain: "windows-host", identity: { display_id: "primary" },
    image: { dimensions: { width: 499, height: 333 }, original_dimensions: { width: 3840, height: 2560 },
      coordinate_space: "display_image_pixels", origin: { x: 0, y: 0, relative_to: "primary_display" } },
    scale: { native_scale_factor: 1.5, dpi: null, device_pixel_ratio: null }, capabilities: { input: "none", detail: "unsupported" } });
  expect(result.details).not.toHaveProperty("observation_id");
  expect(result.details.source?.captured_at).toEqual(expect.any(String));
  const deniedInput = await f.session.act({ window_ref: "primary", observation_id: "display-capture", action: "click", x: 10, y: 10 });
  expect(deniedInput.details.status).toBe("refused"); expect(f.driver.call).toHaveBeenCalledTimes(1);
});

test("Safe, unsupported displays and pre-cancelled reads dispatch no capture", async () => {
  const f = fixture(); f.setMode("safe");
  expect((await f.session.observeDisplay("primary")).details.status).toBe("refused");
  f.setMode("yolo"); expect((await f.session.observeDisplay("secondary")).details.status).toBe("refused");
  const controller = new AbortController(); controller.abort();
  expect((await f.session.observeDisplay("primary", controller.signal)).details.status).toBe("refused");
  expect(f.driver.call).not.toHaveBeenCalled();
});

test("Safe selected during native work withholds every pixel and capture identifier", async () => {
  const f = fixture(); const native = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => { const result = await native(...args); f.setMode("safe"); return result; });
  const result = await f.session.observeDisplay("primary");
  expect(result.details.status).toBe("refused"); expect(result.content.every(block => block.type === "text")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("display-capture"); expect(result.details).not.toHaveProperty("source");
});

test("revoked reads do not leak a native failure diagnostic that may contain private capture data", async () => {
  const f = fixture();
  f.driver.call = vi.fn<Driver["call"]>(async () => { f.setMode("safe"); throw new Error("PRIVATE_NATIVE_CAPTURE_DATA"); });
  const result = await f.session.observeDisplay("primary");
  expect(result.details.status).toBe("refused");
  expect(JSON.stringify(result)).not.toContain("PRIVATE_NATIVE_CAPTURE_DATA");
});
test("cancellation after native capture withholds pixels even if the backend completed", async () => {
  const f = fixture(); const native = f.driver.call; const controller = new AbortController();
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => { const result = await native(...args); controller.abort(); return result; });
  const result = await f.session.observeDisplay("primary", controller.signal);
  expect(result.details.status).toBe("refused"); expect(result.content.every(block => block.type === "text")).toBe(true);
});

test("display settings are frozen before capture and native failure never becomes a window or desktop fallback", async () => {
  const f = fixture(); const native = f.driver.call;
  f.images.update({ kernel: "lanczos3", maxLongEdge: 500, scale: 0.5 });
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    const result = await native(...args);
    f.images.update({ kernel: "lanczos3", maxLongEdge: 1000, scale: 1 });
    return { ...result, structuredContent: { ...result.structuredContent, screenshot_width: 249, screenshot_height: 166 } };
  });
  const result = await f.session.observeDisplay("primary");
  expect(f.driver.call).toHaveBeenCalledWith("get_desktop_state", { max_image_dimension: 250 }, undefined);
  expect(result.details.agent_image).toMatchObject({ configuration: { maxLongEdge: 500, scale: 0.5, version: 1 }, output: { width: 249, height: 166 } });
  vi.mocked(f.driver.call).mockResolvedValueOnce({ isError: true, content: [], structuredContent: { status: "refused" } });
  expect((await f.session.observeDisplay("primary")).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls.every(([name]) => name === "get_desktop_state")).toBe(true);
});
