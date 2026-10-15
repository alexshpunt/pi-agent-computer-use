import { expect, test, vi } from "vitest";
import { ComputerSession, type ComputerMode, type Driver, type DriverResult } from "../src/session.ts";
import { ComputerResources, requireComputerAddress } from "../src/computer-resources.ts";

function fixture() {
  let mode: ComputerMode = "safe", qualified = true, life = "fresh";
  let after: ((name: string) => void) | undefined, imageOn: string | undefined;
  let prepared: Record<string, unknown> = { prepared: true, prepared_pid: 42 };
  let windows = [{ pid: 42, window_id: 91 }];
  const driver: Driver = {
    get domInspection() { return qualified; }, identity: vi.fn(async () => life), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args): Promise<DriverResult> => {
      let state: Record<string, unknown>;
      if (name === "start_session") state = { active: true, session: args.session };
      else if (name === "end_session") state = { active: false, session: args.session };
      else if (name === "browser_prepare") state = prepared;
      else if (name === "list_windows") state = { windows };
      else if (name === "get_browser_state" && !args.snapshot_format) state = { status: "ok", mode: "bind", target_id: "bt-one", binding_quality: "exact", endpoint_access_class: "driver_owned",
        tabs: [{ tab_id: "tab-one", active: true, url: "about:blank", title: "New Tab" }] };
      else if (name === "get_browser_state") state = { status: "ok", mode: "snapshot", target_id: "bt-one", tab_id: "tab-one", page: { url: "about:blank", title: "New Tab" },
        snapshot: { id: "p1", format: "dom_inspect_v1", complete: true, collection_complete: true, matched_count: 0, returned_count: 0, truncated: false,
          scope: "document", omitted: { nodes: 0, depth: 0, frames: 0, metadata: 0, text: 0, hidden_filtered: 0 } }, elements: [] };
      else throw Error(`Unexpected native call: ${name}`);
      after?.(name);
      return { content: name === imageOn ? [{ type: "image", data: "", mimeType: "image/png" }] : [], structuredContent: state };
    }),
  };
  const session = new ComputerSession(driver, () => mode);
  const getSession = vi.fn(async () => session);
  const resources = new ComputerResources(getSession, () => session.close());
  const address = requireComputerAddress("computer:session");
  return { driver, session, resources, address, getSession, calls: () => vi.mocked(driver.call).mock.calls,
    setQualified(v: boolean) { qualified = v; }, setMode(v: ComputerMode) { mode = v; }, setLife(v: string) { life = v; },
    imageOn(name: string) { imageOn = name; },
    after(v: (name: string) => void) { after = v; }, setPrepared(v: Record<string, unknown>) { prepared = v; },
    setWindows(v: typeof windows) { windows = v; } };
}

test("explicit isolated browser open shares the native session with DOM and gives no input authority", async () => {
  const f = fixture();
  const opened = await f.resources.perform(f.address, "/fixture", '{"action":"open_browser"}', "insert");
  expect(opened.details).toMatchObject({ status: "observed", opened: true, window_ref: expect.any(String) });
  expect(opened.details.observation_id).toBeUndefined(); expect(opened.details.dom).toBeUndefined();
  expect(opened.content.every(block => block.type === "text")).toBe(true);
  const read = await f.session.observeDom(opened.details.window_ref!);
  expect(read.details.status).toBe("observed");
  const calls = f.calls();
  expect(calls.map(([name]) => name)).toEqual(["start_session", "browser_prepare", "list_windows", "get_browser_state", "get_browser_state"]);
  expect(calls[1][1]).toEqual({ allow_launch: true, profile: { mode: "isolated_new" }, session: calls[0][1].session });
  expect(calls[2][1]).toEqual({ pid: 42 });
  expect(calls.filter(([name]) => name === "get_browser_state").every(([, args]) => args.session === calls[0][1].session)).toBe(true);
  expect((await f.session.act({ window_ref: opened.details.window_ref!, observation_id: read.details.observation_id!, action: "key", key: "Enter" })).details.status).toBe("refused");
  await f.session.close();
  expect(f.calls().at(-1)).toEqual(["end_session", { session: calls[0][1].session }]);
  expect(f.driver.close).toHaveBeenCalledOnce();
});

test("open_browser rejects extra model fields and non-session addresses before obtaining a runtime", async () => {
  const f = fixture();
  for (const field of ["app", "url", "profile", "pid", "window_id", "target_id", "session", "endpoint"])
    await expect(f.resources.perform(f.address, "/fixture", JSON.stringify({ action: "open_browser", [field]: "foreign" }), "insert")).rejects.toThrow();
  await expect(f.resources.perform(requireComputerAddress("computer:app/foreign"), "/fixture", '{"action":"open_browser"}', "insert")).rejects.toThrow();
  expect(f.getSession).not.toHaveBeenCalled(); expect(f.calls()).toEqual([]);
});

test("unqualified or cancelled browser opening never starts a native session or launches", async () => {
  const f = fixture(), abort = new AbortController();
  f.setQualified(false);
  expect((await f.session.openBrowser()).details.status).toBe("refused");
  f.setQualified(true); abort.abort();
  expect((await f.session.openBrowser(abort.signal)).details.status).toBe("refused");
  expect(f.calls()).toEqual([]);
});

test("cancellation after session start stops before launch and releases the native session", async () => {
  const f = fixture(), abort = new AbortController();
  f.after(name => { if (name === "start_session") abort.abort(); });
  const result = await f.session.openBrowser(abort.signal);
  expect(result.details.status).toBe("refused");
  expect(f.calls().map(([name]) => name)).toEqual(["start_session", "end_session"]);
  expect(f.driver.close).toHaveBeenCalledOnce();
});

test.each(["cancel", "missing-pid", "wrong-owner", "ambiguous", "lost-lifetime"] as const)("%s after prepare remains unknown, releases ownership and never relaunches", async change => {
  const f = fixture(), abort = new AbortController();
  if (change === "cancel") f.after(name => { if (name === "browser_prepare") abort.abort(); });
  if (change === "missing-pid") f.setPrepared({ prepared: true });
  if (change === "wrong-owner") f.setWindows([{ pid: 43, window_id: 91 }]);
  if (change === "ambiguous") f.setWindows([{ pid: 42, window_id: 91 }, { pid: 42, window_id: 92 }]);
  if (change === "lost-lifetime") f.after(name => { if (name === "list_windows") f.setLife(""); });
  const result = await f.session.openBrowser(abort.signal);
  expect(result.details.status).toBe("unknown"); expect(result.details.window_ref).toBeUndefined();
  expect(result.details.state).toMatchObject({ operation: "open_browser", launch_attempted: true });
  expect(f.calls().filter(([name]) => name === "browser_prepare")).toHaveLength(1);
  expect(f.calls().at(-1)?.[0]).toBe("end_session");
  expect(f.driver.close).toHaveBeenCalledOnce();
});

test("Safe ownership admits only the newly prepared exact window, not same-PID siblings", async () => {
  const f = fixture(), opened = await f.session.openBrowser();
  f.setWindows([{ pid: 42, window_id: 91 }, { pid: 42, window_id: 92 }]);
  const listed = (await f.session.windows()).details.state!.windows as { window_ref: string; window_id: number }[];
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ window_ref: opened.details.window_ref, window_id: 91 });
});

test.each(["start_session", "browser_prepare", "list_windows"])("unexpected %s images never grant browser authority", async name => {
  const f = fixture(); f.imageOn(name);
  const result = await f.session.openBrowser();
  expect(result.details.status).toBe(name === "start_session" ? "refused" : "unknown");
  expect(result.details.window_ref).toBeUndefined();
  expect(result.content.every(block => block.type === "text")).toBe(true);
  expect(f.calls().filter(([tool]) => tool === "browser_prepare")).toHaveLength(name === "start_session" ? 0 : 1);
  expect(f.driver.close).toHaveBeenCalledOnce();
});

test("oversized native preparation metadata stops without leaking data or replay", async () => {
  const f = fixture();
  f.setPrepared({ prepared: true, prepared_pid: 42, extra: "x".repeat(70_000) });
  const result = await f.session.openBrowser();
  expect(result.details.status).toBe("unknown"); expect(result.details.window_ref).toBeUndefined();
  expect(JSON.stringify(result).length).toBeLessThan(5_000);
  expect(f.calls().filter(([name]) => name === "browser_prepare")).toHaveLength(1);
});
test("ordinary DOM Read never prepares or replaces an unowned browser", async () => {
  const f = fixture(); f.setMode("yolo");
  const window = ((await f.session.windows()).details.state!.windows as { window_ref: string }[])[0].window_ref;
  await f.session.observeDom(window);
  expect(f.calls().filter(([name]) => name === "browser_prepare")).toEqual([]);
});
