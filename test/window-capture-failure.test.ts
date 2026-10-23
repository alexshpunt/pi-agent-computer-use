import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type Driver, type DriverResult } from "../src/session.ts";

async function fixture() {
  let fail = false; let revoke = false; let mode: "safe" | "yolo" = "yolo";
  const reason = "cannot capture minimized window: it has no rendered content";
  const bytes = await sharp({ create: { width: 100, height: 80, channels: 3, background: "blue" } }).png().toBuffer();
  const image = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
  const driver: Driver = {
    call: vi.fn(async (name): Promise<DriverResult> => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }] } };
      if (name !== "get_window_state") throw Error(`Unexpected native input ${name}`);
      if (revoke) mode = "safe";
      return { content: fail ? [] : [image], structuredContent: { pid: 42, window_id: 91, snapshot_id: "snapshot", capture_id: "capture",
        window_bounds: { x: 10, y: 20, width: 100, height: 80 }, screenshot_width: 100, screenshot_height: 80,
        elements: [{ element_token: "edit", label: "Text editor", role: "Document", actions: ["set_value"] }],
        ...(fail ? { screenshot_error: reason } : {}) } };
    }), identity: vi.fn(async () => "lifetime"), close: vi.fn(async () => {}),
  };
  const session = new ComputerSession(driver, () => mode);
  const discovery = await session.windows();
  const ref = (discovery.details.state!.windows as { window_ref: string }[])[0].window_ref;
  return { session, driver, ref, reason, fail() { fail = true; }, revoke() { revoke = true; } };
}

test("a failed window screenshot keeps its native reason and retires the old input grant", async () => {
  const f = await fixture(); const first = await f.session.observe(f.ref); f.fail();
  const result = await f.session.observe(f.ref);
  expect(result.details).toMatchObject({ status: "refused", window_ref: f.ref, state: { screenshot_error: f.reason } });
  expect(result.content.filter(block => block.type === "text").map(block => block.text).join("\n")).toContain(f.reason);
  for (const key of ["observation_id", "source", "agent_image", "ui"]) expect(result.details).not.toHaveProperty(key);
  expect(result.content.every(block => block.type === "text")).toBe(true);
  const calls = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.act({ window_ref: f.ref, observation_id: first.details.observation_id!, action: "click", x: 20, y: 20 })).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(calls);
});

test("a native error with contradictory image bytes still withholds image and input authority", async () => {
  const f = await fixture(); const call = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    const result = await call(...args);
    if (args[0] === "get_window_state") result.structuredContent!.screenshot_error = f.reason;
    return result;
  });
  const result = await f.session.observe(f.ref);
  expect(result.details).toMatchObject({ status: "refused", state: { screenshot_error: f.reason } });
  expect(result.content.every(block => block.type === "text")).toBe(true);
  expect(result.details).not.toHaveProperty("observation_id");
});

test("a reused native lifetime during failed capture withholds the old diagnostic", async () => {
  const f = await fixture(); f.fail(); const call = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    const result = await call(...args);
    if (args[0] === "get_window_state") vi.mocked(f.driver.identity!).mockResolvedValue("replacement lifetime");
    return result;
  });
  const result = await f.session.observe(f.ref);
  expect(result.details.status).toBe("refused");
  expect(JSON.stringify(result)).not.toContain(f.reason);
  expect(result.details).not.toHaveProperty("state");
});
test("revocation during a failed capture withholds the native diagnostic too", async () => {
  const f = await fixture(); f.fail(); f.revoke();
  const result = await f.session.observe(f.ref);
  expect(result.details.status).toBe("refused");
  expect(JSON.stringify(result)).not.toContain(f.reason);
  expect(result.details).not.toHaveProperty("state");
});

test("UI-only reads do not treat screenshot diagnostics as current pixels or as UI failure", async () => {
  const f = await fixture(); f.fail();
  const result = await f.session.observe(f.ref, undefined, undefined, undefined, undefined, { granularity: "ui" });
  expect(result.details).toMatchObject({ status: "observed", captured: { image: false, ui: true } });
  expect(result.details.state).not.toHaveProperty("screenshot_error");
  expect(result.content.every(block => block.type === "text")).toBe(true);
});
