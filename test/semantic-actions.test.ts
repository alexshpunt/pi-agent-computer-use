import { expect, test, vi } from "vitest";
import { ComputerSession, type Action, type Driver } from "../src/session.ts";

const receipt = (operation: string) => ({ operation, pattern: operation === "select" ? "selection_item" : operation === "set_value" ? "value" : "invoke",
  route: "accessibility", effect: "unverifiable", delivery: { mode: "background" } });
async function fixture() {
  let mode: "safe" | "yolo" = "yolo", alive = true, enabled = true, serial = 0;
  const driver: Driver = {
    identity: vi.fn(async () => alive ? "original" : undefined), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name, args) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 91 }, { pid: 42, window_id: 92 }] } };
      if (name === "get_window_state") return { content: [], structuredContent: { snapshot_id: `s${++serial}`, elements_complete: true,
        elements: [{ element_token: `s${serial}:0`, role: "Button", label: "Synthetic control", enabled, actions: ["invoke"], frame: { x: -100, y: -100, w: 20, h: 20 } }] } };
      return { content: [], structuredContent: receipt(String(args.operation)) };
    }),
  };
  Object.assign(driver, { semanticActions: true });
  const session = new ComputerSession(driver, () => mode);
  const windows = (await session.windows()).details.state!.windows as { window_ref: string }[];
  const observe = () => session.observe(windows[0].window_ref, undefined, undefined, undefined, undefined, { granularity: "ui" });
  const view = await observe();
  const base = { window_ref: windows[0].window_ref, observation_id: view.details.observation_id!, hint: view.details.ui!.elements[0].hint };
  const send = (command: Record<string, unknown>, signal?: AbortSignal) => session.act({ ...base, ...command } as Action, signal);
  const inputs = () => vi.mocked(driver.call).mock.calls.filter(([name]) => name !== "list_windows" && name !== "get_window_state");
  return { driver, session, base, send, inputs, observe, other: windows[1].window_ref,
    safe: () => { mode = "safe"; }, retire: () => { alive = false; }, disable: () => { enabled = false; } };
}

test.each(["invoke", "select", "set_value"])("%s consumes a UI-only token in one strict native call without pixel or foreground fields", async action => {
  const f = await fixture();
  const result = await f.send({ action, ...(action === "set_value" ? { text: "new value" } : {}) });
  expect(result.details.status).toBe("delivered");
  expect(f.inputs()).toEqual([["semantic_action", { pid: 42, window_id: 91, operation: action, element_token: "s1:0",
    ...(action === "set_value" ? { value: "new value" } : {}) }, undefined]]);
  expect(result.details.action_capability).toMatchObject({ native_tool: "semantic_action", route: "accessibility",
    semantic: { pattern: receipt(action).pattern, app_effect: "unverified", focus: "unverified", physical_fallback: false } });
  expect((await f.send({ action })).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(1);
});

test.each([{ x: 1, y: 1 }, { modifiers: ["ctrl"] }, { delivery_mode: "foreground" }, { text: "extra" }, { element_token: "s1:0" }])(
  "strict invoke rejects conflicting or physical fields without dispatch: %j", async extra => {
    const f = await fixture();
    expect((await f.send({ action: "invoke", ...extra })).details.status).toBe("refused");
    expect(f.inputs()).toHaveLength(0);
  });

test("an unqualified runtime refuses all semantic verbs without calling old click/set_value", async () => {
  const f = await fixture(); Object.assign(f.driver, { semanticActions: false });
  for (const action of ["invoke", "select", "set_value"]) expect((await f.send({ action, ...(action === "set_value" ? { text: "" } : {}) })).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0);
});

test.each(["safe", "retire", "disable", "cancel", "other", "stale"])("semantic admission protects %s before native dispatch", async condition => {
  const f = await fixture(); let command: Record<string, unknown> = { action: "invoke" };
  if (condition === "safe") f.safe();
  if (condition === "retire") f.retire();
  if (condition === "disable") { f.disable(); const view = await f.observe(); command = { ...command, observation_id: view.details.observation_id!, hint: view.details.ui!.elements[0].hint }; }
  if (condition === "other") command.window_ref = f.other;
  if (condition === "stale") await f.observe();
  expect((await f.send(command, condition === "cancel" ? AbortSignal.abort() : undefined)).details.status).toBe("refused");
  expect(f.inputs()).toHaveLength(0);
});

test.each([
  { state: { status: "refused", code: "semantic_pattern_unsupported", attempted: false, route: "accessibility", fallback: false }, status: "refused" },
  { state: { status: "refused", code: "semantic_element_stale", attempted: false, route: "accessibility", fallback: false }, status: "refused" },
  { state: { status: "unknown", code: "semantic_provider_failed", attempted: true, route: "accessibility", fallback: false }, status: "unknown" },
  { state: { ...receipt("invoke"), route: "synthetic_events" }, status: "unknown" },
  { state: { ...receipt("invoke"), fallback: true }, status: "unknown" },
  { state: { ...receipt("select") }, status: "unknown" },
])("native semantic failure or inconsistent receipt stays truthful with no fallback: $status", async ({ state, status }) => {
  const f = await fixture(); const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => name === "semantic_action" ? { content: [], structuredContent: state } : call(name, args, signal));
  expect((await f.send({ action: "invoke" })).details.status).toBe(status);
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "semantic_action")).toHaveLength(1);
  expect((await f.send({ action: "invoke" })).details.status).toBe("refused");
});

test("cancellation during a semantic call withholds completion without replay", async () => {
  const f = await fixture(); const call = f.driver.call; const abort = new AbortController();
  f.driver.call = vi.fn(async (name, args, signal) => { const result = await call(name, args, signal); if (name === "semantic_action") abort.abort(); return result; });
  expect((await f.send({ action: "invoke" }, abort.signal)).details.status).toBe("unknown");
  expect((await f.send({ action: "invoke" })).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "semantic_action")).toHaveLength(1);
});
test("permission revoked during a semantic call withholds outcome and never repeats it", async () => {
  const f = await fixture(); const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => { const result = await call(name, args, signal); if (name === "semantic_action") f.safe(); return result; });
  expect((await f.send({ action: "invoke" })).details.status).toBe("unknown");
  expect((await f.send({ action: "invoke" })).details.status).toBe("refused");
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "semantic_action")).toHaveLength(1);
});
