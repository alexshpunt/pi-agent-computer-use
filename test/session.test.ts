import { expect, test, vi } from "vitest";
import { ComputerSession, type Driver, type WindowTarget } from "../src/session.ts";

const target = { pid: 42, window_id: 100 };
function fixture() {
  let windows = [target];
  let generation = "first-lifetime";
  let snapshot = 0;
  const driver: Driver = {
    identity: vi.fn(async (window) => `${window.pid}:${window.window_id}:${generation}`),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: args.pid ? windows.filter(window => window.pid === args.pid) : windows } };
      if (name === "list_apps") return { content: [], structuredContent: {
        apps: [{ name: "Notepad", launch_path: "shell:appsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App", kind: "uwp" }],
      } };
      if (name === "launch_app") {
        const created = { pid: 42, window_id: 101, app_name: "Notepad.exe" };
        windows = [...windows, created];
        return { content: [{ type: "text", text: JSON.stringify({ pid: 43, windows: [created] }) }] };
      }
      if (name === "get_window_state") return {
        content: [{ type: "image", mimeType: "image/png", data: "cG5n" }],
        structuredContent: { ...args, snapshot_id: "s" + ++snapshot,
          elements: [{ element_token: `s${snapshot}:0`, role: "edit", value: "" }] },
      };
      return { content: [], structuredContent: { effect: "unverifiable" } };
    }),
    close: vi.fn(async () => {}),
  };
  return { driver, session: new ComputerSession(driver),
    replaceWindows(value: WindowTarget[]) { windows = value; },
    reuseHandle() { generation = "second-lifetime"; } };
}
async function readExisting(session: ComputerSession) {
  const found = await session.windows();
  const windows = found.details.state!.windows as { window_ref: string }[];
  const ref = windows[0].window_ref;
  return { ref, observed: await session.observe(ref) };
}

test("window observations use the shared cap and keep current host geometry separate from unknown DPI", async () => {
  const f = fixture(); const native = f.driver.call;
  let bounds = { x: 80, y: 90, width: 1000, height: 700 };
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    const result = await native(...args);
    return args[0] === "get_window_state" ? { ...result, structuredContent: { ...result.structuredContent,
      screenshot_width: 500, screenshot_height: 350, window_bounds: bounds } } : result;
  });
  const { ref, observed } = await readExisting(f.session);
  expect(observed.details.source).toMatchObject({ kind: "window", domain: "windows-host", identity: { window_ref: ref, ...target },
    image: { native_bounds: bounds, dimensions: { width: 500, height: 350 }, original_dimensions: null },
    scale: { native_scale_factor: null, dpi: null, device_pixel_ratio: null } });
  expect(observed.content).toContainEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
  expect(vi.mocked(f.driver.call).mock.calls.find(([name]) => name === "get_window_state")?.[1]).toMatchObject({ max_image_dimension: 500 });
  bounds = { x: 200, y: 300, width: 1000, height: 700 };
  expect((await f.session.observe(ref)).details.source?.image.native_bounds).toEqual(bounds);
});
test("discovery, observation and action share identity; native delivery evidence stays action-scoped", async () => {
  const f = fixture(); const found = await f.session.windows();
  const window = (found.details.state!.windows as { window_ref: string; source_identity: unknown }[])[0];
  const observed = await f.session.observe(window.window_ref);
  expect(observed.details.source_identity).toEqual(window.source_identity);
  expect(observed.details.source).toMatchObject(window.source_identity!);
  vi.mocked(f.driver.call).mockResolvedValueOnce({ content: [], structuredContent: {
    effect: "confirmed", route: "accessibility", delivery: { mode: "background" } } });
  const delivered = await f.session.act({ window_ref: window.window_ref, observation_id: observed.details.observation_id!,
    action: "set_value", element_token: "s1:0", text: "Disposable" });
  expect(delivered.details.source_identity).toEqual(window.source_identity);
  expect(delivered.details.action_capability).toMatchObject({ operation: "set_value", background: "delivered", foreground: "unknown" });
  const next = await f.session.observe(window.window_ref);
  vi.mocked(f.driver.call).mockResolvedValueOnce({ isError: true, content: [], structuredContent: {
    code: "background_uipi_blocked", event_kind: "keystroke", escalation: { recommended: "foreground" } } });
  const refused = await f.session.act({ window_ref: window.window_ref, observation_id: next.details.observation_id!,
    action: "key", key: "return" });
  expect(refused.details.status).toBe("refused");
  expect(refused.details.action_capability).toMatchObject({ background: "unavailable", foreground: "suggested" });
  expect((await f.session.act({ window_ref: window.window_ref, observation_id: next.details.observation_id!,
    action: "key", key: "return" })).details.status).toBe("refused");
});

test("another agent's source and observation cannot authorize native input", async () => {
  const one = fixture(), two = fixture();
  const a = await readExisting(one.session), b = await readExisting(two.session);
  expect(a.observed.details.source!.identity.session_id).not.toBe(b.observed.details.source!.identity.session_id);
  const before = vi.mocked(two.driver.call).mock.calls.length;
  for (const window_ref of [a.ref, b.ref]) {
    expect((await two.session.act({ window_ref, observation_id: a.observed.details.observation_id!,
      action: "key", key: "return" })).details.status).toBe("refused");
  }
  expect(two.driver.call).toHaveBeenCalledTimes(before);
});

test("batch receipts retain separate capability evidence for each attempted action", async () => {
  const f = fixture(); const { ref, observed } = await readExisting(f.session);
  vi.mocked(f.driver.call).mockResolvedValueOnce({ content: [], structuredContent: {
    effect: "confirmed", route: "accessibility", delivery: { mode: "background" } } })
    .mockResolvedValueOnce({ content: [], isError: true, structuredContent: {
      code: "background_unavailable", escalation: { recommended: "foreground" } } });
  const result = await f.session.act({ window_ref: ref, observation_id: observed.details.observation_id!,
    action: "sequence", sequence: [{ action: "type_text", element_token: "s1:0", text: "Disposable" }, { action: "key", key: "return" }] });
  const steps = (result.details.state!.sequence as { steps: { action_capability: unknown }[] }).steps;
  expect(steps).toHaveLength(2);
  expect(steps[0].action_capability).toMatchObject({ background: "delivered", foreground: "unknown" });
  expect(steps[1].action_capability).toMatchObject({ background: "unavailable", foreground: "suggested" });
  expect(result.details.action_capability).toBeUndefined();
});
test("opens a genuinely new window and returns its first observation in the same result", async () => {
  const { session, driver } = fixture();
  const opened = await session.open("Notepad");
  expect(opened).toMatchObject({ details: { status: "observed", window_ref: expect.any(String),
    opened: true, observation_id: expect.any(String), target: { pid: 42, window_id: 101 } } });
  expect(opened.content).toContainEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
  expect(driver.call).toHaveBeenCalledWith("launch_app", { aumid: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" }, undefined);
});

test("two catalog paths with the same app name are ambiguous and do not dispatch launch", async () => {
  const { session, driver } = fixture();
  vi.mocked(driver.call).mockResolvedValueOnce({ content: [], structuredContent: { apps: [
    { name: "Notepad", launch_path: "C:\\One\\notepad.exe" },
    { name: "Notepad", launch_path: "C:\\Two\\notepad.exe" },
  ] } });
  expect((await session.open("Notepad")).details.status).toBe("refused");
  expect(driver.call).toHaveBeenCalledTimes(1);
});

test("an interrupted launch is unknown and is never relaunched automatically", async () => {
  const { session, driver } = fixture();
  const call = driver.call;
  driver.call = vi.fn(async (name, args, signal) => {
    if (name === "launch_app") throw new Error("Transport lost after launch");
    return call(name, args, signal);
  });
  const result = await session.open("Notepad");
  expect(result.details.status).toBe("unknown");
  expect(driver.close).toHaveBeenCalledOnce();
  expect(vi.mocked(driver.call).mock.calls.filter(([name]) => name === "launch_app")).toHaveLength(1);
});

test("cancellation before opening does not call native discovery or launch", async () => {
  const { session, driver } = fixture();
  const controller = new AbortController(); controller.abort();
  expect((await session.open("Notepad", controller.signal)).details.status).toBe("refused");
  expect(driver.call).not.toHaveBeenCalled();
});

test("native refusals and partial errors keep their explanation and consume the observation", async () => {
  for (const nativeState of [{ code: "stale_element_token" }, { effect: "partial" }]) {
    const { session, driver } = fixture();
    const { ref, observed } = await readExisting(session);
    vi.mocked(driver.call).mockResolvedValueOnce({ isError: true, structuredContent: nativeState,
      content: [{ type: "text", text: "Native diagnostic" }] });
    const args = { window_ref: ref, observation_id: observed.details.observation_id!,
      action: "type_text" as const, element_token: "s1:0", text: "Hello" };
    const result = await session.act(args);
    expect(result.details.status).toBe("code" in nativeState ? "refused" : "unknown");
    expect(result.details.state).toMatchObject({ ...nativeState, native_message: "Native diagnostic" });
    expect((await session.act(args)).details.status).toBe("refused");
  }
});

test("pixel input needs current scoped image geometry and cannot fall outside it", async () => {
  const { session, driver } = fixture();
  const { ref, observed } = await readExisting(session);
  const before = vi.mocked(driver.call).mock.calls.length;
  expect((await session.act({ window_ref: ref, observation_id: observed.details.observation_id!,
    action: "click", x: 9000, y: 9000 })).details.status).toBe("refused");
  expect(driver.call).toHaveBeenCalledTimes(before);
});
test("missing or ambiguous app names do not launch anything", async () => {
  const { session, driver } = fixture();
  expect((await session.open("Missing app")).details.status).toBe("refused");
  expect(vi.mocked(driver.call).mock.calls.map(([name]) => name)).not.toContain("launch_app");
});

test("a launch returning an existing window is not reported as a new one", async () => {
  const { session, driver } = fixture();
  const call = driver.call;
  driver.call = vi.fn(async (name, args, signal) => name === "launch_app"
    ? { content: [], structuredContent: { pid: 42, windows: [target] } }
    : call(name, args, signal));
  const opened = await session.open("Notepad");
  expect(opened.details.status).toBe("unknown");
  expect(opened.details).not.toHaveProperty("opened", true);
  expect(vi.mocked(driver.call).mock.calls.filter(([n]) => n === "launch_app")).toHaveLength(1);
});

test("YOLO reads existing windows, keeps separate observations, and refuses cross-window tokens", async () => {
  const { session, driver, replaceWindows } = fixture();
  replaceWindows([target, { pid: 42, window_id: 101 }]);
  const found = await session.windows();
  const refs = (found.details.state!.windows as { window_ref: string }[]).map(w => w.window_ref);
  const first = await session.observe(refs[0]);
  const second = await session.observe(refs[1]);
  expect(first.details.window_ref).not.toBe(second.details.window_ref);
  const calls = vi.mocked(driver.call).mock.calls.length;
  const wrong = await session.act({ window_ref: refs[1], observation_id: first.details.observation_id!,
    action: "type_text", text: "No", element_token: "s1:0" });
  expect(wrong.details.status).toBe("refused");
  expect(driver.call).toHaveBeenCalledTimes(calls);
  const accepted = await session.act({ window_ref: refs[0], observation_id: first.details.observation_id!,
    action: "type_text", text: "Hello", element_token: "s1:0" });
  expect(accepted.details.status).toBe("delivered");
  expect(accepted.content[0]).toMatchObject({ text: expect.stringContaining("Observe again") });
  expect(driver.call).toHaveBeenLastCalledWith("type_text", {
    target: { kind: "window", ...target }, element_token: "s1:0", text: "Hello", delivery_mode: "background",
  }, undefined);
});

test("a closed or recycled HWND retires its reference before observation or input", async () => {
  const { session, driver, reuseHandle } = fixture();
  const { ref, observed } = await readExisting(session);
  reuseHandle();
  const before = vi.mocked(driver.call).mock.calls.length;
  expect((await session.act({ window_ref: ref, observation_id: observed.details.observation_id!,
    action: "type_text", text: "Do not dispatch", element_token: "s1:0" })).details.status).toBe("refused");
  expect((await session.observe(ref)).details.status).toBe("refused");
  expect(driver.call).toHaveBeenCalledTimes(before);
});

test("dispatch consumes its observation even when the native outcome is unknown", async () => {
  const { session, driver } = fixture();
  const { ref, observed } = await readExisting(session);
  vi.mocked(driver.call).mockRejectedValueOnce(new Error("transport lost"));
  const args = { window_ref: ref, observation_id: observed.details.observation_id!,
    action: "type_text" as const, text: "Hello", element_token: "s1:0" };
  expect((await session.act(args)).details.status).toBe("unknown");
  expect(driver.close).toHaveBeenCalledOnce();
  const before = vi.mocked(driver.call).mock.calls.length;
  expect((await session.act(args)).details.status).toBe("refused");
  expect(driver.call).toHaveBeenCalledTimes(before);
});

test("a cancelled action does not dispatch or consume its observation", async () => {
  const { session } = fixture();
  const { ref, observed } = await readExisting(session);
  const args = { window_ref: ref, observation_id: observed.details.observation_id!,
    action: "type_text" as const, text: "Hello", element_token: "s1:0" };
  const controller = new AbortController(); controller.abort();
  expect((await session.act(args, controller.signal)).details.status).toBe("refused");
  expect((await session.act(args)).details.status).toBe("delivered");
});

test("a fresh read retires earlier tokens and close invalidates all window references", async () => {
  const { session } = fixture();
  const { ref, observed } = await readExisting(session);
  await session.observe(ref);
  expect((await session.act({ window_ref: ref, observation_id: observed.details.observation_id!,
    action: "set_value", text: "No", element_token: "s1:0" })).details.status).toBe("refused");
  await session.close();
  expect((await session.observe(ref)).details.status).toBe("refused");
});
