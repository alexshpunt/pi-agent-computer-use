import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";

const left = { display_id: "\\\\.\\DISPLAY2", monitor_handle: "0x10002", monitor_device_paths: ["native-left"],
  bounds: { x: -1000, y: -200, width: 1000, height: 800 }, work_area: { x: -1000, y: -200, width: 1000, height: 760 },
  primary: false, scale_factor: 1.5, dpi: null };
const primary = { ...left, display_id: "\\\\.\\DISPLAY1", monitor_handle: "0x10001", monitor_device_paths: ["native-primary"],
  bounds: { x: 0, y: 0, width: 1000, height: 800 }, primary: true };
async function fixture() {
  let mode: ComputerMode = "yolo"; let topology = "native-topology";
  const raw = await sharp({ create: { width: 1000, height: 800, channels: 3, background: "blue" } }).png().toBuffer();
  const small = await sharp({ create: { width: 500, height: 400, channels: 3, background: "red" } }).png().toBuffer();
  const driver = {
    selectedDisplays: true,
    call: vi.fn<Driver["call"]>(async (name, args): Promise<DriverResult> => {
      if (name === "list_displays") return { content: [], structuredContent: { platform: "windows", topology_id: topology, displays: [primary, left] } };
      if (name === "get_display_state") {
        if (args.topology_id !== topology) return { content: [], isError: true, structuredContent: { status: "refused", code: "display_topology_changed" } };
        const full = args.max_image_dimension === 0;
        return { content: [{ type: "image", mimeType: "image/png", data: (full ? raw : small).toString("base64") }],
          structuredContent: { platform: "windows", topology_id: topology, display: { ...(args.display_id === primary.display_id ? primary : left) },
            screenshot_width: full ? 1000 : 500, screenshot_height: full ? 800 : 400, screenshot_original_width: 1000, screenshot_original_height: 800 } };
      }
      throw new Error(`Unexpected native fallback ${name}`);
    }), identity: vi.fn(async () => "unused"), close: vi.fn(async () => {}),
  };
  const session = new ComputerSession(driver, () => mode);
  return { driver, session, setMode(value: ComputerMode) { mode = value; }, changeTopology() { topology = "changed"; } };
}
async function discover(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.session.displays();
  expect(result.details.status).toBe("listed");
  const displays = result.details.state!.displays as { display_ref: string; display_id: string }[];
  return { result, ref: displays.find(d => d.display_id === left.display_id)!.display_ref };
}

test("native discovery and selected pixels keep monitor identity, negative origin and image-local geometry separate", async () => {
  const f = await fixture(); const { result: listed, ref } = await discover(f);
  expect(listed.details.state!.displays).toHaveLength(2);
  const overview = await f.session.observeDisplay(ref);
  expect(overview.details.status).toBe("observed");
  expect(f.driver.call).toHaveBeenLastCalledWith("get_display_state", { display_id: left.display_id, topology_id: "native-topology", max_image_dimension: 500 }, undefined);
  expect(overview.details.source).toMatchObject({ identity: { display_ref: ref, display_id: left.display_id }, membership: { monitor_id: left.display_id },
    image: { scope: "selected_display", origin: { x: 0, y: 0, relative_to: "display" }, native_bounds: left.bounds, coordinate_space: "display_image_pixels" },
    scale: { native_scale_factor: 1.5, dpi: null }, capabilities: { input: "none" } });
  expect(overview.details).not.toHaveProperty("observation_id");
  const count = f.driver.call.mock.calls.length;
  expect((await f.session.act({ window_ref: ref, observation_id: overview.details.agent_image!.image_id as string, action: "click", x: 1, y: 1 })).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(count);
});

test("selected detail uses fresh selected-monitor pixels and never a primary screenshot or host-global crop", async () => {
  const f = await fixture(); const { ref } = await discover(f); const overview = await f.session.observeDisplay(ref);
  const crop = await f.session.observeDisplay(ref, undefined, { image_id: overview.details.agent_image!.image_id as string, x: 100, y: 80, width: 100, height: 80 });
  expect(crop.details.status).toBe("observed");
  const image = crop.content.find(b => b.type === "image")!; if (image.type !== "image") throw Error("missing crop");
  const pixel = await sharp(Buffer.from(image.data, "base64")).raw().toBuffer();
  expect([...pixel.subarray(0, 3)]).toEqual([0, 0, 255]); // Fresh blue native pixels, not the red overview.
  expect(crop.details.source).toMatchObject({ image: { scope: "selected_display_region", origin: { x: 200, y: 160, relative_to: "display" }, native_bounds: left.bounds }, capabilities: { input: "none", detail: "unsupported" } });
  expect(crop.details.agent_image).toMatchObject({ region: { native: { left: 200, top: 160, width: 200, height: 160 } } });
  expect(f.driver.call).toHaveBeenLastCalledWith("get_display_state", { display_id: left.display_id, topology_id: "native-topology", max_image_dimension: 0 }, undefined);
});

test("changed topology refuses a crop without output pixels or primary fallback", async () => {
  const f = await fixture(); const { ref } = await discover(f); const overview = await f.session.observeDisplay(ref); f.changeTopology();
  const result = await f.session.observeDisplay(ref, undefined, { image_id: overview.details.agent_image!.image_id as string, x: 1, y: 1, width: 10, height: 10 });
  expect(result.details.status).toBe("refused"); expect(result.content.every(b => b.type === "text")).toBe(true);
  expect(f.driver.call.mock.calls.every(([name]) => name === "list_displays" || name === "get_display_state")).toBe(true);
});

test("Safe and unsupported runtimes cannot enumerate or dispatch selected-display reads", async () => {
  const f = await fixture(); f.setMode("safe"); expect((await f.session.displays()).details.status).toBe("refused");
  expect(f.driver.call).not.toHaveBeenCalled(); f.setMode("yolo"); f.driver.selectedDisplays = false;
  expect((await f.session.displays()).details.status).toBe("refused"); expect((await f.session.observeDisplay("missing-ref")).details.status).toBe("refused");
  expect(f.driver.call).not.toHaveBeenCalled();
});

test("revocation during discovery/capture withholds native metadata and pixels", async () => {
  for (const phase of ["list_displays", "get_display_state"]) {
    const f = await fixture(); let ref: string | undefined;
    if (phase === "get_display_state") ref = (await discover(f)).ref;
    const call = f.driver.call; f.driver.call = vi.fn(async (...args) => { const result = await call(...args); f.setMode("safe"); return result; });
    const result = ref ? await f.session.observeDisplay(ref) : await f.session.displays();
    expect(result.details.status).toBe("refused"); expect(result.content.every(b => b.type === "text")).toBe(true);
    expect(result.details).not.toHaveProperty("state"); expect(result.details).not.toHaveProperty("source");
  }
});

test("each monitor keeps its own latest overview and a crop cannot cross source references", async () => {
  const f = await fixture(); const { result, ref } = await discover(f);
  const primaryRef = (result.details.state!.displays as { display_ref: string; display_id: string }[]).find(d => d.display_id === primary.display_id)!.display_ref;
  const leftView = await f.session.observeDisplay(ref); const primaryView = await f.session.observeDisplay(primaryRef);
  const request = { image_id: leftView.details.agent_image!.image_id as string, x: 1, y: 1, width: 10, height: 10 };
  const count = f.driver.call.mock.calls.length;
  expect((await f.session.observeDisplay(primaryRef, undefined, request)).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(count);
  expect((await f.session.observeDisplay(ref, undefined, request)).details.status).toBe("observed");
  expect((await f.session.observeDisplay(ref, undefined, request)).details.status).toBe("refused");
  expect((await f.session.observeDisplay(primaryRef, undefined, { ...request, image_id: primaryView.details.agent_image!.image_id as string })).details.status).toBe("observed");
});

test("rediscovery keeps same-topology refs but retires changed topology and close retires all refs", async () => {
  const f = await fixture(); const { ref } = await discover(f);
  expect((await discover(f)).ref).toBe(ref); f.changeTopology();
  const next = (await discover(f)).ref; expect(next).not.toBe(ref);
  const count = f.driver.call.mock.calls.length;
  expect((await f.session.observeDisplay(ref)).details.status).toBe("refused"); expect(f.driver.call).toHaveBeenCalledTimes(count);
  await f.session.close(); expect((await f.session.observeDisplay(next)).details.status).toBe("refused");
});

test("cancellation during native selected capture withholds pixels and does not leave a crop grant", async () => {
  const f = await fixture(); const { ref } = await discover(f); const abort = new AbortController();
  const call = f.driver.call; f.driver.call = vi.fn(async (...args) => { const result = await call(...args); abort.abort(); return result; });
  const result = await f.session.observeDisplay(ref, abort.signal);
  expect(result.details.status).toBe("refused"); expect(result.content.every(b => b.type === "text")).toBe(true);
  expect(result.details).not.toHaveProperty("agent_image");
});

test("selected-monitor reads clear a primary-only human overlay rather than marking another monitor", async () => {
  const f = await fixture(); const observer = vi.fn(async () => ({ status: "shown" as const }));
  const session = new ComputerSession(f.driver, undefined, undefined, observer);
  const listed = await session.displays();
  const ref = (listed.details.state!.displays as { display_ref: string }[])[1].display_ref;
  const view = await session.observeDisplay(ref);
  expect(view.details.status).toBe("observed"); expect(observer).toHaveBeenCalledWith({ clear: true }, undefined);
  expect(view.details.highlight).toMatchObject({ status: "unavailable", reason: "selected_display_overlay_unsupported" });
});
