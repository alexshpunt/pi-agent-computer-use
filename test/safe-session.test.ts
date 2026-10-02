import { expect, test, vi } from "vitest";
import { ComputerSession, type Driver, type WindowTarget } from "../src/session.ts";

function fixture() {
  let mode: "safe" | "yolo" = "yolo";
  let windows = [{ pid: 42, window_id: 100, app_name: "Notepad.exe", title: "Canary" }];
  let next = 100;
  let snapshot = 0;
  const generations = new Map<number, number>();
  const driver: Driver = {
    identity: vi.fn(async target => windows.some(w => w.window_id === target.window_id && w.pid === target.pid)
      ? `${target.pid}:${target.window_id}:${generations.get(target.window_id) ?? 0}` : undefined),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows } };
      if (name === "list_apps") return { content: [], structuredContent: { apps: [{ name: "Notepad", launch_path: "notepad.exe" }] } };
      if (name === "launch_app") {
        const created = { pid: 42, window_id: ++next, app_name: "Notepad.exe", title: "Owned" };
        windows.push(created);
        return { content: [], structuredContent: { pid: 42, windows: [created] } };
      }
      if (name === "get_window_state") return { content: [{ type: "image", data: "cG5n", mimeType: "image/png" }],
        structuredContent: { ...args, elements: [{ element_token: `s${++snapshot}:0`, role: "Document" }], screenshot_width: 100, screenshot_height: 100 } };
      return { content: [], structuredContent: { effect: "confirmed" } };
    }),
    close: vi.fn(async () => {}),
  };
  return { driver, session: new ComputerSession(driver, () => mode),
    mode(value: "safe" | "yolo") { mode = value; },
    recycle(target: WindowTarget) { generations.set(target.window_id, (generations.get(target.window_id) ?? 0) + 1); } };
}
async function canary(session: ComputerSession) {
  const listed = await session.windows();
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const observed = await session.observe(ref);
  return { ref, observed, action: { window_ref: ref, observation_id: observed.details.observation_id!,
    action: "type_text" as const, element_token: (observed.details.state!.elements as { element_token: string }[])[0].element_token, text: "Allowed only in YOLO" } };
}

test("switching to Safe blocks an old canary read and write before native work; YOLO restores access", async () => {
  const f = fixture();
  const before = await canary(f.session);
  f.mode("safe");
  vi.mocked(f.driver.call).mockClear(); vi.mocked(f.driver.identity).mockClear();
  expect((await f.session.observe(before.ref)).details).toMatchObject({ status: "refused", mode: "safe" });
  expect((await f.session.act(before.action)).details).toMatchObject({ status: "refused", mode: "safe" });
  expect(f.driver.call).not.toHaveBeenCalled();
  expect(f.driver.identity).not.toHaveBeenCalled();
  f.mode("yolo");
  expect((await f.session.observe(before.ref)).details).toMatchObject({ status: "observed", mode: "yolo" });
});

test("Safe with no owned windows exposes no outside-session metadata or native UI reads", async () => {
  const f = fixture();
  await canary(f.session);
  f.mode("safe");
  vi.mocked(f.driver.call).mockClear(); vi.mocked(f.driver.identity).mockClear();
  expect((await f.session.windows()).details).toMatchObject({ status: "listed", mode: "safe", state: { windows: [] } });
  expect(f.driver.call).not.toHaveBeenCalled();
  expect(f.driver.identity).not.toHaveBeenCalled();
});

test("Safe opening owns only the new window, not its existing same-PID sibling", async () => {
  const f = fixture();
  const outside = await canary(f.session);
  f.mode("safe");
  const opened = await f.session.open("Notepad");
  expect(opened.details).toMatchObject({ status: "observed", mode: "safe", target: { pid: 42, window_id: 101 } });
  const listed = await f.session.windows();
  expect(listed.details.state!.windows).toHaveLength(1);
  expect(listed.details.state!.windows).toMatchObject([{ window_ref: opened.details.window_ref, window_id: 101 }]);
  expect((await f.session.observe(outside.ref)).details.status).toBe("refused");
  const read = await f.session.observe(opened.details.window_ref!);
  expect((await f.session.act({ window_ref: opened.details.window_ref!, observation_id: read.details.observation_id!,
    action: "type_text", element_token: (read.details.state!.elements as { element_token: string }[])[0].element_token,
    text: "Owned window" })).details).toMatchObject({ status: "delivered", mode: "safe" });
});

test("an individually opened YOLO window remains owned after the user selects Safe", async () => {
  const f = fixture();
  const opened = await f.session.open("Notepad");
  f.mode("safe");
  expect((await f.session.observe(opened.details.window_ref!)).details.status).toBe("observed");
  expect((await f.session.windows()).details.state!.windows).toMatchObject([{ window_id: 101 }]);
});

test("Safe cannot adopt a recycled HWND even when its process ID is unchanged", async () => {
  const f = fixture();
  const opened = await f.session.open("Notepad");
  f.mode("safe");
  f.recycle(opened.details.target!);
  vi.mocked(f.driver.call).mockClear();
  expect((await f.session.observe(opened.details.window_ref!)).details.status).toBe("refused");
  expect(f.driver.call).not.toHaveBeenCalled();
  expect((await f.session.windows()).details.state!.windows).toEqual([]);
});

test("ambiguous launch candidates are not silently adopted as Safe-owned windows", async () => {
  const f = fixture();
  const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => {
    const result = await call(name, args, signal);
    if (name === "launch_app") await call(name, args, signal);
    return result;
  });
  expect((await f.session.open("Notepad")).details.status).toBe("unknown");
  f.mode("safe");
  expect((await f.session.windows()).details.state!.windows).toEqual([]);
});

test("a mode change while identity work awaits is checked again before native input", async () => {
  const f = fixture();
  const outside = await canary(f.session);
  vi.mocked(f.driver.identity).mockImplementationOnce(async target => {
    f.mode("safe");
    return `${target.pid}:${target.window_id}:0`;
  });
  vi.mocked(f.driver.call).mockClear();
  expect((await f.session.act(outside.action)).details).toMatchObject({ status: "refused", mode: "safe" });
  expect(f.driver.call).not.toHaveBeenCalled();
});

test("switching during discovery withholds foreign rows collected before the switch", async () => {
  const f = fixture();
  await canary(f.session);
  await f.session.open("Notepad");
  vi.mocked(f.driver.identity).mockImplementation(async target => {
    if (target.window_id === 101) f.mode("safe");
    return `${target.pid}:${target.window_id}:0`;
  });
  const listed = await f.session.windows();
  expect(listed.details.mode).toBe("safe");
  expect(listed.details.state!.windows).toMatchObject([{ window_id: 101 }]);
  expect(listed.details.state!.windows).toHaveLength(1);
});

test("Safe cannot cancel already-dispatched YOLO input but withholds its returned UI state", async () => {
  const f = fixture();
  const outside = await canary(f.session);
  const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => {
    if (name === "type_text") {
      f.mode("safe");
      return { content: [], structuredContent: { effect: "confirmed", value: "Private canary" } };
    }
    return call(name, args, signal);
  });
  const result = await f.session.act(outside.action);
  expect(result.details).toMatchObject({ status: "unknown", mode: "safe" });
  expect(result.details.state).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("Private canary");
  expect(f.driver.call).toHaveBeenCalledWith("type_text", expect.any(Object), undefined);
});

test("a mode change during an in-flight read withholds even native error UI state", async () => {
  const f = fixture();
  const outside = await canary(f.session);
  const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => {
    if (name === "get_window_state") {
      f.mode("safe");
      return { isError: true, content: [], structuredContent: { elements: [{ value: "Private canary" }] } };
    }
    return call(name, args, signal);
  });
  const refused = await f.session.observe(outside.ref);
  expect(refused.details).toMatchObject({ status: "refused", mode: "safe" });
  expect(refused.details.state).toBeUndefined();
  expect(JSON.stringify(refused)).not.toContain("Private canary");
});

test("closing the runtime drops ownership rather than adopting surviving app windows", async () => {
  const f = fixture();
  await f.session.open("Notepad");
  await f.session.close();
  f.mode("safe");
  expect((await f.session.windows()).details.state!.windows).toEqual([]);
});
