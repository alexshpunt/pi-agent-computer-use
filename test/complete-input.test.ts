import { expect, test, vi } from "vitest";
import { ComputerSession, SEQUENCE_ELAPSED_MS, type Action, type ComputerMode, type Driver } from "../src/session.ts";

async function fixture() {
  let mode: ComputerMode = "yolo", lifetime = "alive";
  const driver: Driver = {
    heldPaths: true, identity: vi.fn(async () => lifetime), close: vi.fn(async () => {}),
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
  [{ action: "click", x: 100, y: 80, count: 3 }, "click", { x: 100, y: 80, count: 3, capture_id: "capture-one" }],
  [{ action: "click", element_token: "field", button: "right", count: 2 }, "click", { element_token: "field", button: "right", count: 2 }],
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
  { action: "click", x: 10, y: 10, count: 4 }, { action: "click", x: 10, y: 10, count: 0 }, { action: "double_click", x: 10, y: 10, count: 3 },
  { action: "sequence", sequence: [] },
  { action: "sequence", sequence: [{ action: "key", key: "a" }, { action: "drag", from_x: 1, from_y: 1, to_x: NaN, to_y: 2 }] },
  { action: "sequence", sequence: [{ action: "hover", x: 10, y: 10 }] },
  { action: "sequence", sequence: Array.from({ length: 2001 }, () => ({ action: "key", key: "a" })) },
  { action: "sequence", sequence: Array.from({ length: 181 }, () => ({ action: "key", key: "a", wait_ms: 5000 })) },
])("rejects the entire unsupported or ungrounded command before input: %j", async command => {
  const f = await fixture();
  expect((await f.send(command)).details.status).toBe("refused"); expect(f.input()).toHaveLength(0);
  expect((await f.send({ action: "key", key: "return" })).details.status).toBe("delivered");
});

test("a qualified straight drag keeps both endpoints in the captured window image", async () => {
  const f = await fixture(); Object.assign(f.driver, { captureBoundDrag: true });
  const result = await f.send({ action: "drag", from_x: 30, from_y: 40, to_x: 200, to_y: 80, duration_ms: 250, steps: 12 });
  expect(result.details.status).toBe("delivered");
  expect(f.input()).toEqual([["drag", { target: { kind: "window", pid: 42, window_id: 100 }, delivery_mode: "background",
    capture_id: "capture-one", from_x: 30, from_y: 40, to_x: 200, to_y: 80, duration_ms: 250, steps: 12 }, undefined]]);
});

test("a qualified drag with no native capture refuses the entire batch before its first key", async () => {
  const f = await fixture(); Object.assign(f.driver, { captureBoundDrag: true }); const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => {
    const result = await call(name, args, signal);
    if (name === "get_window_state" && result.structuredContent) delete result.structuredContent.capture_id;
    return result;
  });
  const view = await f.session.observe(f.base.window_ref);
  const result = await f.session.act({ window_ref: f.base.window_ref, observation_id: view.details.observation_id!, action: "sequence",
    sequence: [{ action: "key", key: "a" }, { action: "drag", from_x: 10, from_y: 10, to_x: 20, to_y: 20 }] });
  expect(result.details.status).toBe("refused"); expect(f.input()).toHaveLength(0);
});
test("native resize refusal stops a capture-bound drag batch without replay or an unbound fallback", async () => {
  const f = await fixture(); Object.assign(f.driver, { captureBoundDrag: true }); const call = f.driver.call;
  f.driver.call = vi.fn(async (name, args, signal) => name === "drag" && args.capture_id === "capture-one"
    ? { content: [], isError: true, structuredContent: { code: "capture_frame_mismatch", effect: "refused" } }
    : call(name, args, signal));
  const command = { action: "sequence", sequence: [{ action: "key", key: "a" },
    { action: "drag", from_x: 10, from_y: 10, to_x: 20, to_y: 20 }, { action: "key", key: "b" }] };
  const result = await f.send(command);
  expect(result.details.status).toBe("refused");
  expect(result.details.state!.sequence).toMatchObject({ total: 3, attempted: 2, completed: 1 });
  expect(f.input().map(([name]) => name)).toEqual(["press_key", "drag"]);
  expect((await f.send(command)).details.status).toBe("refused"); expect(f.input()).toHaveLength(2);
});
test("an inactive held-path backend refuses the whole sequence before its first key", async () => {
  const f = await fixture(); f.driver.heldPaths = false;
  const result = await f.send({ action: "sequence", sequence: [
    { action: "key", key: "a" },
    { action: "drag", from_x: 1, from_y: 1, via: [{ x: 10, y: 20 }], to_x: 30, to_y: 40 },
  ] });
  expect(result.details.status).toBe("refused"); expect(f.input()).toHaveLength(0);
});
test("a curved drag forwards all local points once and preserves a partial native receipt", async () => {
  const f = await fixture(); Object.assign(f.driver, { captureBoundDrag: true });
  f.driver.call = vi.fn(async () => ({ content: [], structuredContent: {
    effect: "partial", delivery: { delivered_count: 2 }, summary: "2/4 points; pressed=true released=true",
  } }));
  const result = await f.send({ action: "sequence", delivery_mode: "foreground", sequence: [
    { action: "drag", from_x: 20, from_y: 30, via: [{ x: 40, y: 80 }, { x: 90, y: 70 }], to_x: 100, to_y: 30, duration_ms: 800 },
    { action: "key", key: "a" },
  ] });
  expect(f.driver.call).toHaveBeenCalledExactlyOnceWith("drag", {
    pid: 42, window_id: 100, delivery_mode: "foreground", from_x: 20, from_y: 30,
    via: [{ x: 40, y: 80 }, { x: 90, y: 70 }], to_x: 100, to_y: 30, duration_ms: 800,
  }, undefined);
  expect(result.details.status).toBe("unknown");
  expect(result.details.state).toMatchObject({ delivery: { delivered_count: 2 }, summary: "2/4 points; pressed=true released=true",
    sequence: { attempted: 1, completed: 0 } });
  expect((await f.send({ action: "key", key: "a" })).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(1);
});

test.each([
  { via: [] }, { via: [{ x: 500, y: 1 }] }, { via: [{ x: NaN, y: 2 }] },
  { via: [{ x: 2, y: Infinity }] }, { via: [{ x: 2, y: 3, desktop: true }] },
  { via: Array.from({ length: 255 }, () => ({ x: 2, y: 3 })) },
  { via: [{ x: 2, y: 3 }], steps: 10 }, { via: [{ x: 2, y: 3 }], modifiers: [] },
  { via: [{ x: 2, y: 3 }], button: "middle" },
])("an invalid curved tail prevents every batch input: %j", async tail => {
  const f = await fixture();
  const result = await f.send({ action: "sequence", sequence: [{ action: "key", key: "a" },
    { action: "drag", from_x: 1, from_y: 1, to_x: 10, to_y: 10, ...tail }] });
  expect(result.details.status).toBe("refused"); expect(f.input()).toHaveLength(0);
});

test("admission snapshots the entire path before asynchronous native targeting", async () => {
  const f = await fixture(); const via = [{ x: 40, y: 80 }];
  f.driver.identity = vi.fn(async () => { via[0].x = 499; via.push({ x: 100, y: 110 }); return "alive"; });
  const result = await f.send({ action: "drag", from_x: 20, from_y: 30, via, to_x: 100, to_y: 30 });
  expect(result.details.status).toBe("delivered");
  expect(f.input()[0][1].via).toEqual([{ x: 40, y: 80 }]);
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

// Models write Enter, ESC or Control+S; the benchmark lost turns to "Unsupported key" for them (LPT-838).
test("common key spellings reach the driver under its own names, and an unknown key names the valid ones", async () => {
  const f = await fixture();
  const result = await f.send({ action: "sequence", sequence: [
    { action: "key", key: "Enter" }, { action: "key", key: "ESC", modifiers: ["Shift"] }, { action: "hotkey", keys: ["Control", "S"] },
    { action: "key", key: "minus" }, { action: "key", key: "/" }] });
  expect(result.details.status).toBe("delivered");
  expect(f.input().map(([, args]) => args.key ?? args.keys)).toEqual(["return", "escape", ["ctrl", "s"], "-", "/"]);
  expect(f.input()[1][1].modifiers).toEqual(["shift"]);
  const unknown = await (await fixture()).send({ action: "key", key: "Enterr" });
  expect(unknown.details.status).toBe("refused");
  expect(JSON.stringify(unknown.content)).toMatch(/Unsupported key \\"enterr\\". Use a-z, 0-9, .*return \(Enter\)/);
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

test("CUA's occlusion refusal stops a sequence without calling it unknown or retrying it", async () => {
  const f = await fixture();
  f.driver.call = vi.fn(async () => ({ isError: true, content: [], structuredContent: {
    code: "background_occluded", cause: "Target point is occluded; no coordinate injection was sent.",
  } }));
  const result = await f.send({ action: "sequence", sequence: [{ action: "key", key: "a" }, { action: "key", key: "b" }] });
  expect(result.details.status).toBe("refused");
  expect(result.details.state!.sequence).toMatchObject({ attempted: 1, completed: 0 });
  expect(f.driver.call).toHaveBeenCalledTimes(1);
  expect((await f.send({ action: "key", key: "a" })).details.status).toBe("refused");
  expect(f.driver.call).toHaveBeenCalledTimes(1);
});
test("maximum held paths return readable counts rather than a truncated point dump", async () => {
  const f = await fixture();
  const sequence = Array.from({ length: 32 }, () => ({ action: "drag", from_x: 20, from_y: 30,
    via: Array.from({ length: 254 }, (_, i) => ({ x: 20 + i / 2, y: 30 + i / 2 })), to_x: 200, to_y: 200, duration_ms: 0 }));
  const result = await f.send({ action: "sequence", delivery_mode: "foreground", sequence });
  expect(result.details.status).toBe("delivered");
  const content = result.content.find(block => block.type === "text")!;
  if (content.type !== "text") throw Error("Missing receipt");
  const readable = JSON.parse(content.text.slice(content.text.indexOf("{")));
  expect(readable.state.sequence.steps).toHaveLength(32);
  expect(readable.state.sequence.steps.every((step: { requested: { via_points: number; via?: unknown } }) =>
    step.requested.via_points === 254 && step.requested.via === undefined)).toBe(true);
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
  f.driver.identity = vi.fn<Driver["identity"]>(async (...args) => { if (++checks === 2) now = SEQUENCE_ELAPSED_MS; return identity(...args); });
  try {
    const result = await f.send({ action: "sequence", sequence: [{ action: "key", key: "a" }, { action: "key", key: "b" }] });
    expect(result.details.status).toBe("refused");
    expect(f.input()).toHaveLength(1);
    expect(result.details.state!.sequence).toMatchObject({ attempted: 1, completed: 1 });
  } finally { clock.mockRestore(); }
});
test.each(["cancel", "safe", "recycle"])("sequence stops before another dispatch on %s", async interruption => {
  const f = await fixture(), abort = new AbortController(); Object.assign(f.driver, { captureBoundDrag: true }); const native = f.driver.call;
  f.driver.call = vi.fn<Driver["call"]>(async (...args) => {
    const result = await native(...args);
    if (interruption === "cancel") abort.abort();
    if (interruption === "safe") f.mode("safe");
    if (interruption === "recycle") f.recycle();
    return result;
  });
  const result = await f.send({ action: "sequence", sequence: [{ action: "key", key: "a" }, { action: "drag", from_x: 10, from_y: 10, to_x: 20, to_y: 20, wait_ms: 200 }] }, abort.signal);
  expect(result.details.status).not.toBe("delivered"); expect(f.input()).toHaveLength(1);
  expect(result.details.state!.sequence).toMatchObject({ total: 2, attempted: 1 });
});
