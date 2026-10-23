import { expect, test, vi } from "vitest";
import sharp from "sharp";
import { ComputerSession, type ComputerMode, type Driver } from "../src/session.ts";

const first = "00112233-4455-6677-8899-aabbccddeeff";
const second = "11223344-5566-7788-99aa-bbccddeeff00";
const membership = (desktop_id: string, on_current_desktop = false) => ({ desktop_id, on_current_desktop,
  desktop_id_error: null, on_current_desktop_error: null, sampled_at_unix_ms: 42 });
async function fixture() {
  let mode: ComputerMode = "yolo"; let desktop: unknown = membership(first); let lifetime = "one";
  const pixels = (await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer()).toString("base64");
  const driver: Driver = { identity: vi.fn(async () => lifetime), close: vi.fn(async () => {}),
    call: vi.fn(async name => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91, title: "fixture", virtual_desktop: desktop }] } };
      if (name === "get_window_state") return { content: [{ type: "image" as const, mimeType: "image/png", data: pixels }], structuredContent: {
        screenshot_width: 20, screenshot_height: 20, window_bounds: { x: 0, y: 0, width: 20, height: 20 }, elements: [], virtual_desktop: desktop } };
      throw Error("Unexpected call " + name);
    }) };
  return { session: new ComputerSession(driver, () => mode), driver, desktop(value: unknown) { desktop = value; },
    mode(value: ComputerMode) { mode = value; }, recreate() { lifetime = "two"; } };
}
const window = (result: Awaited<ReturnType<ComputerSession["windows"]>>) =>
  (result.details.state!.windows as { window_ref: string; source_identity: { membership: { virtual_desktop_id: string | null } } }[])[0];

test("discovery and overview sample changing desktop membership without changing the window reference", async () => {
  const f = await fixture(); const found = window(await f.session.windows());
  expect(found.source_identity.membership.virtual_desktop_id).toBe(first);
  f.desktop(membership(second, true));
  const observed = await f.session.observe(found.window_ref);
  expect(observed.details.source_identity?.membership.virtual_desktop_id).toBe(second);
  expect(observed.details.source?.virtual_desktop).toMatchObject({ status: "sampled", desktop_id: second, on_current_desktop: true });
  expect(window(await f.session.windows()).window_ref).toBe(found.window_ref);
  f.desktop(undefined);
  expect(window(await f.session.windows()).source_identity.membership.virtual_desktop_id).toBeNull();
  expect((await f.session.observe(found.window_ref)).details.source?.virtual_desktop).toEqual({ status: "unknown", reason: "not_reported" });
});

test("Safe revocation withholds outside-window membership before native reads", async () => {
  const f = await fixture(); const found = window(await f.session.windows()); f.mode("safe");
  const count = vi.mocked(f.driver.call).mock.calls.length;
  expect((await f.session.windows()).details.state).toEqual({ windows: [] });
  expect((await f.session.observe(found.window_ref)).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(count);
});

test("a recreated native handle cannot reuse membership or observation authority from the old lifetime", async () => {
  const f = await fixture(); const old = window(await f.session.windows()); f.recreate(); f.desktop(membership(second));
  expect((await f.session.observe(old.window_ref)).details.status).toBe("refused");
  const fresh = window(await f.session.windows());
  expect(fresh.window_ref).not.toBe(old.window_ref);
  expect(fresh.source_identity.membership.virtual_desktop_id).toBe(second);
});
