import { expect, test, vi } from "vitest";
import { ComputerSession, type Action, type ComputerMode, type Driver } from "../src/session.ts";

async function fixture() {
  let mode: ComputerMode = "yolo", lifetime = "alive";
  const driver: Driver = {
    identity: vi.fn(async () => lifetime), close: vi.fn(async () => {}),
    call: vi.fn<Driver["call"]>(async (name) => {
      if (name === "list_windows") return { content: [], structuredContent: { windows: [{ pid: 42, window_id: 100 }] } };
      if (name === "get_window_state") return { content: [{ type: "image", mimeType: "image/png", data: "cG5n" }], structuredContent: {
        elements: [{ element_token: "field" }], screenshot_width: 500, screenshot_height: 350, capture_id: "capture-one",
      } };
      return { content: [], structuredContent: { effect: "unverifiable" } };
    }),
  };
  const session = new ComputerSession(driver, () => mode);
  const listed = await session.windows();
  const ref = (listed.details.state!.windows as { window_ref: string }[])[0].window_ref;
  const overview = await session.observe(ref);
  const base = { window_ref: ref, observation_id: overview.details.observation_id! };
  const send = (command: Record<string, unknown>, signal?: AbortSignal) => session.act({ ...base, ...command } as Action, signal);
  const input = () => vi.mocked(driver.call).mock.calls.filter(([name]) => !["list_windows", "get_window_state"].includes(name));
  return { session, driver, send, base, input, mode: (value: ComputerMode) => { mode = value; }, recycle: () => { lifetime = "reused"; } };
}

test.each([
  [{ action: "key", key: "up", modifiers: ["shift"] }, "press_key", { key: "up", modifiers: ["shift"] }],
  [{ action: "hotkey", keys: ["ctrl", "a"] }, "hotkey", { keys: ["ctrl", "a"] }],
  [{ action: "type_text", text: "abc", delay_ms: 20 }, "type_text", { text: "abc", delay_ms: 20 }],
  [{ action: "right_click", x: 100, y: 80, modifiers: ["shift"] }, "right_click", { x: 100, y: 80, modifier: ["shift"] }],
  [{ action: "double_click", element_token: "field" }, "double_click", { element_token: "field" }],
  [{ action: "click", x: 100, y: 80, button: "middle" }, "click", { x: 100, y: 80, button: "middle", capture_id: "capture-one" }],
  [{ action: "scroll", element_token: "field", direction: "down", amount: 2, by: "page" }, "scroll", { element_token: "field", direction: "down", amount: 2, by: "page" }],
  [{ action: "drag", from_x: 30, from_y: 40, to_x: 200, to_y: 80, duration_ms: 250, steps: 12, button: "left", modifiers: ["ctrl"] }, "drag",
    { from_x: 30, from_y: 40, to_x: 200, to_y: 80, duration_ms: 250, steps: 12, button: "left", modifier: ["ctrl"] }],
])("maps complete native input without a desktop or browser route: %j", async (command, nativeName, expected) => {
  const f = await fixture();
  expect((await f.send(command)).details.status).toBe("delivered");
  const target = ["right_click", "double_click"].includes(nativeName) ? { pid: 42, window_id: 100 } : { target: { kind: "window", pid: 42, window_id: 100 } };
  expect(f.input()).toEqual([[nativeName, { ...target, delivery_mode: "background", ...expected }, undefined]]);
  expect((await f.send(command)).details.status).toBe("refused");
  expect(f.input()).toHaveLength(1);
});

test.each([
  { action: "key", key: "key_down" }, { action: "key", key: "a", modifiers: ["hyper"] },
  { action: "hotkey", keys: ["a", "b"] }, { action: "hotkey", keys: ["ctrl", "ctrl", "a"] },
  { action: "type_text", text: "abc", delay_ms: 201 }, { action: "type_text", text: "x".repeat(2001) },
  { action: "drag", from_x: 10, from_y: 10, to_x: 500, to_y: 20 },
  { action: "drag", from_x: 10, from_y: 10, to_x: 20, to_y: 20, steps: 201 },
  { action: "drag", from_x: 10, from_y: 10, to_x: 20, to_y: 20, duration_ms: 10001 },
  { action: "scroll", direction: "down", amount: 51 }, { action: "scroll", direction: "sideways" },
  { action: "scroll", x: 100, y: 80, direction: "down" },
  { action: "scroll", direction: "down", amount: 2 },
  { action: "key", key: "a", duration_ms: 1000 }, { action: "click", x: 10, y: 10, keys: ["ctrl", "a"] },
  { action: "sequence", sequence: [] },
  { action: "sequence", sequence: [{ action: "key", key: "a" }, { action: "drag", from_x: 1, from_y: 1, to_x: NaN, to_y: 2 }] },
  { action: "sequence", sequence: [{ action: "click", x: 10, y: 10 }] },
  { action: "sequence", sequence: Array.from({ length: 33 }, () => ({ action: "key", key: "a" })) },
  { action: "sequence", sequence: [{ action: "key", key: "a", wait_ms: 30001 }] },
])("rejects the entire unsupported or ungrounded command before input: %j", async command => {
  const f = await fixture();
  expect((await f.send(command)).details.status).toBe("refused"); expect(f.input()).toHaveLength(0);
  expect((await f.send({ action: "key", key: "return" })).details.status).toBe("delivered");
});

test("a bounded sequence dispatches complete steps once, without new captures, and measures waits", async () => {
  const f = await fixture();
  const result = await f.send({ action: "sequence", sequence: [
    { action: "key", key: "a" }, { action: "hotkey", keys: ["shift", "b"], wait_ms: 20 },
    { action: "drag", from_x: 10, from_y: 10, to_x: 20, to_y: 20, duration_ms: 0, steps: 1 },
  ] });
  expect(result.details.status).toBe("delivered");
  expect(f.input().map(([name]) => name)).toEqual(["press_key", "hotkey", "drag"]);
  const trace = result.details.state!.sequence as { total: number; completed: number; attempted: number; steps: { status: string; requested_wait_ms: number; dispatch_ms: number; completion_ms: number }[] };
  expect(trace).toMatchObject({ total: 3, completed: 3, attempted: 3 });
  expect(trace.steps.map(step => step.status)).toEqual(["delivered", "delivered", "delivered"]);
  expect(trace.steps[1].requested_wait_ms).toBe(20);
  expect(trace.steps[1].dispatch_ms - trace.steps[0].completion_ms).toBeGreaterThanOrEqual(19);
  expect(vi.mocked(f.driver.call).mock.calls.filter(([name]) => name === "get_window_state")).toHaveLength(1);
  expect((await f.send({ action: "key", key: "a" })).details.status).toBe("refused");
});

test.each(["refused", "partial", "throw"])("sequence stops after %s with a truthful completed prefix and no replay", async failure => {
  const f = await fixture(); const native = f.driver.call; let n = 0;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    if (++n === 2) {
      if (failure === "throw") throw new Error("transport lost during input");
      return { isError: true, content: [{ type: "text", text: "native diagnostic" }], structuredContent: { effect: failure } };
    }
    return native(...args);
  });
  const result = await f.send({ action: "sequence", sequence: ["a", "b", "c"].map(key => ({ action: "key", key })) });
  expect(result.details.status).toBe(failure === "refused" ? "refused" : "unknown");
  expect(f.input()).toHaveLength(2);
  expect(result.details.state!.sequence).toMatchObject({ total: 3, attempted: 2, completed: 1 });
  expect((await f.send({ action: "key", key: "c" })).details.status).toBe("refused");
  expect(f.input()).toHaveLength(2);
});

test("the maximum stroke sequence returns every measured step as readable JSON", async () => {
  const f = await fixture();
  const sequence = Array.from({length:32}, () => ({action:"drag",from_x:11.123456789123456,from_y:22.98765432198765,
    to_x:100.12345678912345,to_y:200.98765432198765,duration_ms:0,steps:200,button:"middle",modifiers:["ctrl","shift","alt","win"]}));
  const result = await f.send({action:"sequence",sequence});
  const content = result.content.find(block => block.type === "text")!;
  if (content.type !== "text") throw Error("Missing receipt");
  const readable = JSON.parse(content.text.slice(content.text.indexOf("{")));
  expect(readable.state.sequence.steps).toHaveLength(32);
});
test("sequence stops if admission uses the remaining elapsed budget", async () => {
  const f = await fixture(); let now = 0, checks = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const identity = f.driver.identity;
  f.driver.identity = vi.fn<Driver["identity"]>(async (...args) => { if (++checks === 2) now = 45000; return identity(...args); });
  try {
    const result = await f.send({ action: "sequence", sequence: [{ action: "key", key: "a" }, { action: "key", key: "b" }] });
    expect(result.details.status).toBe("refused");
    expect(f.input()).toHaveLength(1);
    expect(result.details.state!.sequence).toMatchObject({ attempted: 1, completed: 1 });
  } finally { clock.mockRestore(); }
});
test.each(["cancel", "safe", "recycle"])("sequence stops before another dispatch on %s", async interruption => {
  const f = await fixture(), abort = new AbortController(); const native = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    const result = await native(...args);
    if (interruption === "cancel") abort.abort();
    if (interruption === "safe") f.mode("safe");
    if (interruption === "recycle") f.recycle();
    return result;
  });
  const result = await f.send({ action: "sequence", sequence: [{ action: "key", key: "a" }, { action: "key", key: "b", wait_ms: 200 }] }, abort.signal);
  expect(result.details.status).not.toBe("delivered"); expect(f.input()).toHaveLength(1);
  expect(result.details.state!.sequence).toMatchObject({ total: 2, attempted: 1 });
});
