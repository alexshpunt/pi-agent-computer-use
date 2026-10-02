import { expect, test, vi } from "vitest";
import { ComputerSession, type Driver } from "../src/session.ts";

const target = { pid: 42, window_id: 100 };
const state = {
  snapshot_id: "s1",
  elements: [{ element_token: "s1:0", role: "edit", value: "", enabled: true }],
};
function fixture() {
  const driver: Driver = {
    call: vi.fn<Driver["call"]>(async (name) => ({
      content: name === "get_window_state"
        ? [{ type: "image", mimeType: "image/png", data: "cG5n" }]
        : [],
      structuredContent: name === "get_window_state" ? state : { effect: "unverifiable" },
    })),
    close: vi.fn(async () => {}),
  };
  return { driver, session: new ComputerSession(driver, target) };
}

test("refuses another window before any native observation", async () => {
  const { session, driver } = fixture();
  const result = await session.observe({ pid: 42, window_id: 101 });
  expect(result.isError).toBe(true);
  expect(result.details.status).toBe("refused");
  expect(driver.call).not.toHaveBeenCalled();
});

test("preserves the screenshot and structured element tokens in an observation", async () => {
  const { session } = fixture();
  const result = await session.observe(target);
  expect(result.details.status).toBe("observed");
  expect(result.details.state).toMatchObject(state);
  expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: "cG5n" });
  expect(result.details.observation_id).toEqual(expect.any(String));
});

test("a fresh read retires earlier references, and cross-window tokens never dispatch", async () => {
  const { session, driver } = fixture();
  const first = await session.observe(target);
  const second = await session.observe(target);
  for (const args of [
    { observation_id: first.details.observation_id!, element_token: "s1:0" },
    { observation_id: second.details.observation_id!, element_token: "another-window:0" },
  ]) {
    const result = await session.act({ target, action: "type_text", text: "Hello", ...args });
    expect(result.details.status).toBe("refused");
  }
  expect(driver.call).toHaveBeenCalledTimes(2);
});

test("dispatch consumes its observation; input delivery is not verification", async () => {
  const { session, driver } = fixture();
  const observed = await session.observe(target);
  const args = { target, action: "type_text" as const, text: "Hello", element_token: "s1:0",
    observation_id: observed.details.observation_id! };
  const delivered = await session.act(args);
  expect(delivered.details.status).toBe("delivered");
  expect(delivered.details.state).toEqual({ effect: "unverifiable" });
  expect(delivered.content[0]).toMatchObject({ text: expect.stringContaining("Observe again") });
  expect(await session.act(args)).toMatchObject({ isError: true, details: { status: "refused" } });
  const sent = vi.mocked(driver.call).mock.calls.at(-1)![1];
  expect(sent).not.toHaveProperty("pid");
  expect(sent).not.toHaveProperty("window_id");
  expect(sent).not.toHaveProperty("scope");
  expect(driver.call).toHaveBeenLastCalledWith("type_text", expect.objectContaining({
    target: { kind: "window", ...target }, element_token: "s1:0", delivery_mode: "background",
  }), undefined);
});

test("native errors retain their explanation; partial effects are unknown, not clean refusals", async () => {
  for (const state of [{ code: "invalid_action_target" }, { effect: "partial" }]) {
    const { session, driver } = fixture();
    const observed = await session.observe(target);
    vi.mocked(driver.call).mockResolvedValueOnce({
      isError: true, structuredContent: state,
      content: [{ type: "text", text: "Native diagnostic" }],
    });
    const result = await session.act({ target, action: "type_text", text: "Hello",
      element_token: "s1:0", observation_id: observed.details.observation_id! });
    expect(result.details.status).toBe("code" in state ? "refused" : "unknown");
    expect(result.details.state).toMatchObject({ ...state, native_message: "Native diagnostic" });
    expect((await session.act({ target, action: "type_text", text: "Hello",
      element_token: "s1:0", observation_id: observed.details.observation_id! })).details.status).toBe("refused");
    expect(driver.call).toHaveBeenCalledTimes(2);
  }
});

test("an interrupted dispatched action is unknown and is never automatically retried", async () => {
  const { session, driver } = fixture();
  const observed = await session.observe(target);
  vi.mocked(driver.call).mockRejectedValueOnce(new Error("transport lost"));
  const result = await session.act({ target, action: "type_text", text: "Hello",
    element_token: "s1:0", observation_id: observed.details.observation_id! });
  expect(result).toMatchObject({ isError: true, details: { status: "unknown" } });
  expect(driver.close).toHaveBeenCalledOnce();
  expect(driver.call).toHaveBeenCalledTimes(2);
  expect(result.content[0]).toMatchObject({ text: expect.stringContaining("may have changed") });
});

test("an already cancelled action does not dispatch or consume its observation", async () => {
  const { session, driver } = fixture();
  const observed = await session.observe(target);
  const args = { target, action: "type_text" as const, text: "Hello", element_token: "s1:0",
    observation_id: observed.details.observation_id! };
  const controller = new AbortController();
  controller.abort();
  const cancelled = await session.act(args, controller.signal);
  expect(cancelled.details.status).toBe("refused");
  expect(driver.call).toHaveBeenCalledTimes(1);
  expect((await session.act(args)).details.status).toBe("delivered");
});
