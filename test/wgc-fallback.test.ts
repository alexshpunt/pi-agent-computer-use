import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type Driver, type DriverResult } from "../src/session.ts";

const png = (await sharp({ create: { width: 500, height: 300, channels: 3, background: "white" } }).png().toBuffer()).toString("base64");

function session(failures: number) {
  let left = failures;
  const call = vi.fn<Driver["call"]>(async (name, args): Promise<DriverResult> => {
    if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 7, window_id: 70 }] } };
    if (name !== "get_window_state") throw new Error(`Unexpected native call ${name}`);
    if (args.capture_backend === "wgc" && left-- > 0) return { content: [], isError: true, structuredContent: { code: "wgc_capture_failed" } };
    return { content: [{ type: "image", mimeType: "image/png", data: png }], structuredContent: {
      pid: 7, window_id: 70, screenshot_width: 500, screenshot_height: 300, capture_id: "capture-1",
      window_bounds: { x: 0, y: 0, width: 500, height: 300 }, screenshot_original_width: 500, screenshot_original_height: 300, elements: [],
      ...(args.capture_backend === "wgc" ? { capture_backend: { backend: "wgc" } } : {}) } };
  });
  const driver: Driver = { persistentWgc: true, call, identity: vi.fn(async () => "life"), close: vi.fn(async () => {}) };
  return { call, session: new ComputerSession(driver) };
}
const routes = (call: ReturnType<typeof session>["call"]) => call.mock.calls.filter(([name]) => name === "get_window_state").map(([, args]) => args.capture_backend ?? "default");

test("a one-off WGC failure is retried on WGC", async () => {
  const f = session(1);
  const ref = ((await f.session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const result = await f.session.observe(ref, undefined, undefined, undefined, undefined, {});
  expect(result.details.status, JSON.stringify(result.content).slice(0, 300)).toBe("observed");
  expect(routes(f.call)).toEqual(["wgc", "wgc"]);
});

test("a persistent WGC failure on the runtime default falls back to the default route and says so", async () => {
  const f = session(2);
  const ref = ((await f.session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const result = await f.session.observe(ref, undefined, undefined, undefined, undefined, {});
  expect(result.details.status, JSON.stringify(result.content).slice(0, 300)).toBe("observed");
  expect(routes(f.call)).toEqual(["wgc", "wgc", "default"]);
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("WGC capture failed (wgc_capture_failed); this overview used the default capture route.") });
});

test("an explicitly requested WGC route never falls back", async () => {
  const f = session(2);
  const ref = ((await f.session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  const result = await f.session.observe(ref, undefined, undefined, undefined, undefined, { backend: "wgc" });
  expect(result.details.status).toBe("refused");
  expect(routes(f.call)).toEqual(["wgc", "wgc"]);
});
