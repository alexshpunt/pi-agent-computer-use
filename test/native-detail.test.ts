import { expect, test, vi } from "vitest";
import sharp from "sharp";
import * as detailProcessing from "../src/native-detail.ts";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";

async function fixture() {
  let mode: ComputerMode = "yolo";
  let bounds = { x: 10, y: 20, width: 1000, height: 800 };
  const raw = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "red" } })
    .composite([{ input: await sharp({ create: { width: 200, height: 160, channels: 3, background: "blue" } }).png().toBuffer(), left: 200, top: 160 }]).png().toBuffer();
  const small = await sharp(raw).resize(500, 400).png().toBuffer();
  const jpeg = await sharp(raw).extract({ left: 100, top: 80, width: 280, height: 240 }).jpeg().toBuffer();
  const png = (bytes: Buffer) => ({ type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") });
  const driver: Driver = {
    call: vi.fn<Driver["call"]>(async (name, args): Promise<DriverResult> => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91, bounds }] } };
      if (name === "get_window_state") return { content: [png(small)], structuredContent: {
        pid: 42, window_id: 91, screenshot_width: 500, screenshot_height: 400, window_bounds: { ...bounds }, capture_id: "window-capture",
        elements: [{ element_token: "button", label: "test", actions: ["click"] }],
      } };
      if (name === "zoom") return { content: [{ type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") }],
        structuredContent: { width: 280, height: 240, x_offset: 100, y_offset: 80 } };
      if (name === "get_desktop_state") { const native = args.max_image_dimension === 0;
        return { content: [png(native ? raw : small)], structuredContent: { display: "primary", platform: "windows", capture_id: "private-display-id",
          screenshot_width: native ? 1000 : 500, screenshot_height: native ? 800 : 400, screen_width: 1000, screen_height: 800,
          screenshot_original_width: 1000, screenshot_original_height: 800, scale_factor: 1 } }; }
      throw new Error(`Unexpected native call ${name}`);
    }), identity: vi.fn(async () => "lifetime"), close: vi.fn(async () => {}),
  };
  const session = new ComputerSession(driver, () => mode);
  return { session, driver, raw, setMode(value: ComputerMode) { mode = value; }, setBounds(value: typeof bounds) { bounds = value; } };
}
function imageId(view: Awaited<ReturnType<ComputerSession["observeDisplay"]>>) { return view.details.agent_image?.image_id as string; }
const rect = { x: 100, y: 80, width: 100, height: 80 };

test("runtime reset retires earlier display geometry even if the next request restarts its peer", async () => {
  const f = await fixture(); const view = await f.session.observeDisplay("primary"); const call = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    if (args[0] === "list_apps") throw Error("peer disconnected");
    return call(...args);
  });
  expect((await f.session.apps()).details.status).toBe("refused");
  const count = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.observeDisplay("primary", undefined, { ...rect, image_id: imageId(view) })).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(count);
});

test("an overview whose raster and reported dimensions disagree cannot ground a detail", async () => {
  const f = await fixture(); const call = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    const result = await call(...args);
    if (args[0] === "get_desktop_state") result.structuredContent!.screenshot_width = 499;
    return result;
  });
  const view = await f.session.observeDisplay("primary"); const count = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.observeDisplay("primary", undefined, { ...rect, image_id: imageId(view) })).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(count);
});

test("revocation and cancellation during adapter processing withhold final pixels", async () => {
  for (const cancel of [false, true]) {
    const f = await fixture(); const overview = await f.session.observeDisplay("primary"); const controller = new AbortController();
    const crop = detailProcessing.cropDisplay;
    const processing = vi.spyOn(detailProcessing, "cropDisplay").mockImplementation(async (...args) => {
      const result = await crop(...args); if (cancel) controller.abort(); else f.setMode("safe"); return result;
    });
    try {
      const result = await f.session.observeDisplay("primary", controller.signal, { ...rect, image_id: imageId(overview) });
      expect(result.details.status).toBe("refused"); expect(result.content.every(b => b.type === "text")).toBe(true);
      expect(result.details).not.toHaveProperty("source"); expect(JSON.stringify(result)).not.toContain("private-display-id");
    } finally { processing.mockRestore(); }
  }
});

test("detail scaling is bounded and fractional rectangles map outwards once", async () => {
  const f = await fixture(); const overview = await f.session.observeDisplay("primary");
  const result = await f.session.observeDisplay("primary", undefined, { image_id: imageId(overview), x: 100.25, y: 80.25, width: 99.5, height: 79.5, maxLongEdge: 100, scale: 0.5 });
  expect(result.details.status).toBe("observed");
  expect(result.details.agent_image).toMatchObject({ region: { native: { left: 200, top: 160, width: 200, height: 160 } }, output: { width: 50, height: 40 } });
});

test("Safe selected or native handle lost during window zoom withholds its pixels", async () => {
  for (const revoke of [false, true]) {
    const f = await fixture(); const discovered = await f.session.windows();
    const ref = (discovered.details.state!.windows as {window_ref:string}[])[0].window_ref;
    const overview = await f.session.observe(ref); const call = f.driver.call;
    f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
      const result = await call(...args);
      if(args[0] === "zoom") { if(revoke) f.setMode("safe"); else vi.mocked(f.driver.identity).mockResolvedValue(undefined); }
      return result;
    });
    const result = await f.session.observe(ref, undefined, undefined, { ...rect, image_id: imageId(overview) });
    expect(result.details.status).toBe("refused"); expect(result.content.every(b => b.type === "text")).toBe(true);
  }
});

test("display detail extracts fresh native pixels, reports mapping and never enlarges or publishes the raw display", async () => {
  const f = await fixture(); const overview = await f.session.observeDisplay("primary");
  expect(imageId(overview)).toEqual(expect.any(String));
  const detail = await f.session.observeDisplay("primary", undefined, { ...rect, image_id: imageId(overview), maxLongEdge: 1200, scale: 1 });
  expect(detail.details.status).toBe("observed");
  expect(f.driver.call).toHaveBeenLastCalledWith("get_desktop_state", { max_image_dimension: 0 }, undefined);
  expect(detail.details.source).toMatchObject({ kind: "display", image: { scope: "primary_display_region", coordinate_space: "detail_image_pixels",
    dimensions: { width: 200, height: 160 }, origin: { x: 200, y: 160, relative_to: "primary_display" } }, capabilities: { input: "none" } });
  const image = detail.content.find(block => block.type === "image")!;
  if (image.type !== "image") throw Error("Missing detail");
  const pixel = await sharp(Buffer.from(image.data, "base64")).removeAlpha().raw().toBuffer();
  expect([...pixel.subarray(0, 3)]).toEqual([0, 0, 255]);
  expect(JSON.stringify(detail)).not.toContain(f.raw.toString("base64"));
  expect(JSON.stringify(detail)).not.toContain("private-display-id");
  expect(detail.details.agent_image).toMatchObject({ route: "cua_fresh_display_crop", configuration: { maxLongEdge: 1200, scale: 1 }, region: { native: { left: 200, top: 160, width: 200, height: 160 } } });
  expect((await f.session.observeDisplay("primary", undefined, { ...rect, image_id: imageId(overview) })).details.status).toBe("refused");
  const again = await f.session.observeDisplay("primary"); expect(again.details.agent_image).toMatchObject({ configuration: { maxLongEdge: 500, scale: 1 } });
});

test("invalid, missing and retired display regions are rejected before native work", async () => {
  const f = await fixture();
  expect((await f.session.observeDisplay("primary", undefined, { ...rect, image_id: "unknown" })).details.status).toBe("refused");
  expect(f.driver.call).not.toHaveBeenCalled();
  const first = await f.session.observeDisplay("primary"); const latest = await f.session.observeDisplay("primary"); const count = vi.mocked(f.driver.call).mock.calls.length;
  for (const zoom of [{ ...rect, image_id: imageId(first) }, { ...rect, x: -1, image_id: imageId(latest) },
    { ...rect, width: 900, image_id: imageId(latest) }, { ...rect, maxLongEdge: 9000, image_id: imageId(latest) }, { ...rect, x: NaN, image_id: imageId(latest) }])
    expect((await f.session.observeDisplay("primary", undefined, zoom)).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(count);
});

test("display geometry drift, Safe revocation and cancelled capture withhold pixels and private diagnostics", async () => {
  for (const route of ["geometry", "revoke", "cancel", "private-error"]) {
    const f = await fixture(); const overview = await f.session.observeDisplay("primary"); const call = f.driver.call; const controller = new AbortController();
    f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
      if (route === "private-error") { f.setMode("safe"); throw Error("PRIVATE_RAW_PIXELS"); }
      const result = await call(...args);
      if (route === "geometry") result.structuredContent!.screen_width = 1200;
      if (route === "revoke") f.setMode("safe");
      if (route === "cancel") controller.abort();
      return result;
    });
    const result = await f.session.observeDisplay("primary", controller.signal, { ...rect, image_id: imageId(overview) });
    expect(result.details.status).toBe("refused"); expect(result.content.every(b => b.type === "text")).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_RAW_PIXELS|private-display-id/);
  }
  const f = await fixture(); const overview = await f.session.observeDisplay("primary"); f.setMode("safe");
  const count = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.observeDisplay("primary", undefined, { ...rect, image_id: imageId(overview) })).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(count);
});

test("native window zoom consumes overview input and preserves CUA JPEG padding without wider capture or raise", async () => {
  const f = await fixture(); const discovered = await f.session.windows(); const ref = (discovered.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const overview = await f.session.observe(ref);
  const zoom = await f.session.observe(ref, undefined, undefined, { ...rect, image_id: imageId(overview) });
  expect(zoom.details.status).toBe("observed");
  expect(f.driver.call).toHaveBeenCalledWith("zoom", { pid: 42, window_id: 91, x1: 100, y1: 80, x2: 200, y2: 160 }, undefined);
  expect(zoom.content.some(b => b.type === "image" && b.mimeType === "image/jpeg")).toBe(true);
  expect(zoom.details.source).toMatchObject({ capabilities: { input: "none" }, image: { scope: "native_window_zoom", coordinate_space: "zoom_image_pixels" } });
  expect(zoom.details).not.toHaveProperty("observation_id");
  const count = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.act({ window_ref: ref, observation_id: overview.details.observation_id!, action: "click", x: 10, y: 20 })).details.status).toBe("refused");
  expect((await f.session.observe(ref, undefined, undefined, { ...rect, image_id: imageId(overview) })).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(count);
  expect(vi.mocked(f.driver.call).mock.calls.some(([name]) => ["bring_to_front", "get_desktop_state", "click"].includes(name))).toBe(false);
});

test("window movement, shrinking and growth preserve the original local zoom rectangle", async () => {
  for (const bounds of [{ x: 200, y: 300, width: 1000, height: 800 },
    { x: 200, y: 300, width: 300, height: 240 }, { x: 200, y: 300, width: 2000, height: 1600 }]) {
    const f = await fixture(); const listed = await f.session.windows();
    const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
    const view = await f.session.observe(ref); f.setBounds(bounds);
    const result = await f.session.observe(ref, undefined, undefined, { ...rect, image_id: imageId(view) });
    expect(result.details.status).toBe("observed");
    expect(f.driver.call).toHaveBeenCalledWith("zoom", { pid: 42, window_id: 91, x1: 100, y1: 80, x2: 200, y2: 160 }, undefined);
    expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "get_window_state")).toHaveLength(1);
  }
});

test("movement during native zoom does not discard its fresh pixels", async () => {
  const f = await fixture(); const listed = await f.session.windows();
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const view = await f.session.observe(ref); const call = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    const result = await call(...args);
    if (args[0] === "zoom") f.setBounds({ x: 500, y: 600, width: 1100, height: 900 });
    return result;
  });
  expect((await f.session.observe(ref, undefined, undefined, { ...rect, image_id: imageId(view) })).details.status).toBe("observed");
});

test("window lifetime loss and Safe still withhold detail", async () => {
  for (const route of ["closed", "safe"]) {
    const f = await fixture(); const listed = await f.session.windows(); const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
    const view = await f.session.observe(ref);
    if (route === "closed") vi.mocked(f.driver.identity).mockResolvedValue(undefined);
    if (route === "safe") f.setMode("safe");
    expect((await f.session.observe(ref, undefined, undefined, { ...rect, image_id: imageId(view) })).details.status).toBe("refused");
    expect(vi.mocked(f.driver.call).mock.calls.some(([name]) => name === "zoom")).toBe(false);
  }
});
